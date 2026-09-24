// In-memory subset of @azure/cosmos used by host/memory/store/cosmos.mjs.
// Each CosmosClient owns its containers, so contract tests stay isolated.

function notFound() {
  const err = new Error('Entity not found');
  err.code = 404;
  return err;
}

function conflict() {
  const err = new Error('Entity with the specified id already exists');
  err.code = 409;
  return err;
}

function docKey(id, partitionKey) {
  return `${partitionKey}\0${id}`;
}

function matchCondition(doc, condition, params) {
  const trimmed = condition.trim();
  if (trimmed === '1=1') return true;

  const includes = trimmed.match(/^c\.(\w+)\s+IN\s*\(([^)]+)\)$/i);
  if (includes) {
    const field = includes[1];
    const values = includes[2].split(',').map((name) => params[name.trim()]);
    return values.includes(doc[field]);
  }

  const contains = trimmed.match(/^CONTAINS\(c\.(\w+),\s*(@\w+),\s*true\)$/i);
  if (contains) {
    const field = contains[1];
    const needle = String(params[contains[2]] ?? '');
    return String(doc[field] ?? '').toLowerCase().includes(needle.toLowerCase());
  }

  throw new Error(`mock Cosmos cannot evaluate condition: ${trimmed}`);
}

export function runCosmosQuery(docs, { query, parameters = [] }) {
  const params = Object.fromEntries(parameters.map((p) => [p.name, p.value]));
  const whereMatch = query.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER BY\b|\s*$)/i);
  const where = whereMatch ? whereMatch[1] : '1=1';
  let rows = docs.filter((doc) => (
    where.split(/\s+AND\s+/i).every((part) => matchCondition(doc, part, params))
  ));

  if (/SELECT\s+VALUE\s+COUNT\(1\)/i.test(query)) return [rows.length];

  const order = query.match(/ORDER BY\s+c\.(\w+)\s+(ASC|DESC)/i);
  if (order) {
    const field = order[1];
    const desc = order[2].toUpperCase() === 'DESC';
    rows.sort((a, b) => {
      const av = a[field] ?? 0;
      const bv = b[field] ?? 0;
      if (av === bv) return 0;
      return desc ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
    });
  }

  const offset = query.match(/OFFSET\s+(\d+)/i);
  const limit = query.match(/LIMIT\s+(\d+)/i);
  const start = offset ? Number(offset[1]) : 0;
  const end = limit ? start + Number(limit[1]) : undefined;
  return rows.slice(start, end).map((doc) => structuredClone(doc));
}

function createContainer() {
  const docs = new Map();

  return {
    items: {
      async create(doc) {
        const key = docKey(doc.id, doc.partitionKey);
        if (docs.has(key)) throw conflict();
        docs.set(key, structuredClone(doc));
        return { resource: structuredClone(doc) };
      },
      query(spec) {
        return {
          async fetchAll() {
            return { resources: runCosmosQuery([...docs.values()], spec) };
          },
        };
      },
    },
    item(id, partitionKey) {
      const key = docKey(id, partitionKey);
      return {
        async read() {
          const doc = docs.get(key);
          if (!doc) throw notFound();
          return { resource: structuredClone(doc) };
        },
        async replace(doc) {
          if (!docs.has(key)) throw notFound();
          docs.set(key, structuredClone(doc));
          return { resource: structuredClone(doc) };
        },
        async delete() {
          if (!docs.delete(key)) throw notFound();
          return { statusCode: 204 };
        },
      };
    },
  };
}

export class CosmosClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.key = options.key;
    const containers = new Map();
    this.databases = {
      async createIfNotExists({ id: databaseId }) {
        return {
          database: {
            containers: {
              async createIfNotExists({ id: containerId }) {
                const mapKey = `${databaseId}/${containerId}`;
                if (!containers.has(mapKey)) containers.set(mapKey, createContainer());
                return { container: containers.get(mapKey) };
              },
            },
          },
        };
      },
    };
  }
}
