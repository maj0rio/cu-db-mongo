// Заполняйте TODO. c — переданная база; функции выполняют реальные запросы MongoDB.
// Служебный lab.js менять не требуется. Контракты и порядок опытов — в Задание.md.
globalThis.installValidator = async c => {
  // $jsonSchema проверяет типы и структуру; $expr — то, что схемой не выражается:
  // уникальность size внутри variants (число элементов == число уникальных размеров).
  const sizes = {$map: {input: '$variants', as: 'v', in: '$$v.size'}};
  const validator = {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'name', 'category', 'price', 'variants'],
      properties: {
        _id: {bsonType: 'string'},
        name: {bsonType: 'string'},
        category: {bsonType: 'string'},
        price: {bsonType: 'decimal', minimum: 0},
        variants: {
          bsonType: 'array',
          items: {
            bsonType: 'object',
            required: ['size', 'stock'],
            properties: {
              size: {bsonType: 'string'},
              stock: {bsonType: ['int', 'long'], minimum: 0}
            }
          }
        }
      }
    },
    $expr: {
      $cond: [
        {$isArray: '$variants'},
        {$eq: [{$size: '$variants'}, {$size: {$setUnion: [sizes, []]}}]},
        false
      ]
    }
  };
  return c.runCommand({
    collMod: 'products',
    validator,
    validationLevel: 'strict',
    validationAction: 'error'
  });
};

// Возврат: Promise массива полных Product; порядок _id ASC; [] при отсутствии.
globalThis.searchProducts = async (c, {category, size, qty}) => {
  // $elemMatch: size и stock проверяются на ОДНОМ элементе массива variants.
  return c.products.find({
    category,
    variants: {$elemMatch: {size, stock: {$gte: qty}}}
  }).sort({_id: 1}).toArray();
};

// Технический helper: верните MongoDB cursor с фильтром, сортировкой и limit.
// Один и тот же запрос используется для результата и explain в опыте с индексом.
globalThis.historyCursor = (c, {userId, status}) => {
  return c.orders.find({userId, status}).sort({createdAt: -1, _id: 1}).limit(20);
};
globalThis.history = async (c, input) => historyCursor(c, input).toArray();

// Заполните порядок полей и направления индекса для historyCursor.
// ESR: равенства (userId, status), затем сортировка (createdAt DESC, _id ASC).
globalThis.historyIndex = {userId: 1, status: 1, createdAt: -1, _id: 1};
// Если добавили hint в historyCursor, измените флаг на true.
globalThis.usesHistoryHint = false;

// Возврат: Promise массива {sku, name, qty, revenue}; revenue — Decimal128.
globalThis.report = async (c, from, to) => {
  return c.orders.aggregate([
    // только оплаченные, период [from, to)
    {$match: {status: 'paid', createdAt: {$gte: from, $lt: to}}},
    {$unwind: '$items'},
    // размеры одного товара объединяются группировкой по sku
    {$group: {
      _id: '$items.sku',
      qty: {$sum: '$items.qty'},
      // цена берётся из позиции заказа (историческая), а не из каталога
      revenue: {$sum: {$multiply: ['$items.qty', '$items.price']}}
    }},
    {$lookup: {from: 'products', localField: '_id', foreignField: '_id', as: 'product'}},
    {$unwind: '$product'},
    {$project: {_id: 0, sku: '$_id', name: '$product.name', qty: 1, revenue: 1}},
    {$sort: {revenue: -1, sku: 1}},
    {$limit: 5}
  ]).toArray();
};

// request: {operationId, userId, items:[{sku,size,qty},{sku,size,qty}]}.
// Входы соответствуют контракту задания. Два SKU различны; порядок items значим.
// Возврат: Promise созданного или ранее сохранённого Order.
// При отказе: throw HWError('ITEM_UNAVAILABLE') или HWError('REQUEST_CONFLICT').
// Сообщение ошибки свободное; сценарий проверяет только error.code.
// transaction(body) предоставлена: body получает c — базу в активной сессии.
// Все операции покупки внутри body выполняйте через этот c.
globalThis.purchase = async (request, trace = () => {}) => {
  return transaction(async c => {
    // После попытки каждого списания передавайте trace:
    // {event:'update_inside_transaction', sku, matched:r.matchedCount,
    //  modified:r.modifiedCount}, где r — настоящий результат updateOne.
    // Это позволяет показать первое успешное изменение перед abort.
    // Идемпотентность: _id заказа == operationId. Сравниваем только userId и
    // sku/size/qty по порядку — не JSON-текст и не текущую цену каталога.
    const existing = await c.orders.findOne({_id: request.operationId});
    if (existing) {
      const same = Number(existing.userId) === Number(request.userId) &&
        existing.items.length === request.items.length &&
        existing.items.every((it, i) => it.sku === request.items[i].sku &&
          it.size === request.items[i].size && Number(it.qty) === Number(request.items[i].qty));
      if (!same) throw HWError('REQUEST_CONFLICT');
      return existing;
    }

    const items = [];
    for (const {sku, size, qty} of request.items) {
      // Проверка остатка — часть условия обновления: проверка и списание атомарны.
      const r = await c.products.updateOne(
        {_id: sku, variants: {$elemMatch: {size, stock: {$gte: qty}}}},
        {$inc: {'variants.$.stock': NumberInt(-qty)}}
      );
      trace({event: 'update_inside_transaction', sku, matched: r.matchedCount, modified: r.modifiedCount});
      // Исключение → оболочка transaction делает abort и откатывает прошлые списания.
      if (r.matchedCount !== 1) throw HWError('ITEM_UNAVAILABLE');
      // Цена на момент покупки читается в той же транзакции (snapshot).
      // В mongosh второй аргумент findOne — сама проекция, а не объект опций.
      const {price} = await c.products.findOne({_id: sku}, {price: 1});
      items.push({sku, size, qty: NumberInt(qty), price});
    }

    const order = {
      _id: request.operationId,
      userId: NumberInt(request.userId),
      createdAt: new Date(),
      status: 'created',
      items
    };
    await c.orders.insertOne(order);
    return c.orders.findOne({_id: order._id});
  });
};

// Используйте именно переданный c: он связан с одним MongoDB-клиентом опыта.
// writeProbe: сохранить {_id:id, message} в c.probe с majority и j:true.
// Возврат — результат записи с acknowledged:true. Повтор вызова с тем же id
// должен быть безопасен: оболочка опыта может повторить запись после ошибки связи.
globalThis.writeProbe = async (c, id, message) => {
  // upsert по _id: повтор после ошибки связи не создаёт дубль и безопасен.
  return c.probe.updateOne(
    {_id: id},
    {$set: {message}},
    {upsert: true, writeConcern: {w: 'majority', j: true, wtimeout: 10000}}
  );
};
// Возврат — документ c.probe с указанным _id либо null.
globalThis.readProbe = async (c, id) => {
  // readPreference=primary задан в URI подключения: читаем с текущего primary.
  return c.probe.findOne({_id: id});
};

