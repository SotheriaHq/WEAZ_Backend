// Deterministic fashion catalogue for search quality and capacity proofs. Rows
// are only ever written to a disposable database owned by the calling script.
const { createHash } = require('node:crypto');
const {
  DEFAULT_COLLECTION_CATEGORIES,
  DEFAULT_SUB_CATEGORIES,
  DEFAULT_FILTER_DIMENSIONS,
} = require('../../src/categories/default-taxonomy');

const fixtureId = (name) => {
  const hex = createHash('sha256').update(`search-fixture:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** mulberry32: a fixed sequence, so every run measures the same catalogue. */
function sequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRANDS = [
  'Adunni Atelier', 'Zuri Threads', 'Kosi Couture', 'Ebele Studio',
  'House of Tari', 'Naya Kente House', 'Okoro Tailors', 'Bisi Bespoke',
  'Danfo Denim', 'Lagos Linen Co', 'Amara Moda', 'Tunde Stitch',
  'Omoge Closet', 'Kano Weave', 'Calabar Coast', 'Iyawo Bridal',
  'Eko Street', 'Benin Royal', 'Sahel Robes', 'Nneka Knits',
];

// "Wine" is stored as its curated canonical "Burgundy"; "Navy" is a stored value.
const COLORS = [
  'Black', 'White', 'Red', 'Royal Blue', 'Sky Blue', 'Navy', 'Emerald Green',
  'Olive Green', 'Yellow', 'Pink', 'Purple', 'Brown', 'Gold', 'Silver',
  'Burgundy', 'Cream', 'Peach', 'Teal',
];

const AUDIENCE = {
  'dresses-gowns': ['FEMALE'],
  'tops-shirts': ['MALE', 'FEMALE', 'EVERYBODY'],
  'trousers-shorts': ['MALE', 'FEMALE', 'EVERYBODY'],
  skirts: ['FEMALE'],
  'suits-blazers': ['MALE', 'FEMALE'],
  'co-ord-sets': ['FEMALE', 'EVERYBODY'],
  outerwear: ['MALE', 'FEMALE', 'EVERYBODY'],
  agbada: ['MALE'],
  'senator-wear': ['MALE'],
  kaftans: ['MALE', 'FEMALE'],
  'buba-wrapper': ['FEMALE'],
  'native-sets': ['MALE', 'FEMALE', 'EVERYBODY'],
  'bridal-wear': ['FEMALE'],
};
const FABRICS = {
  'trousers-shorts': ['cotton', 'linen', 'denim', 'ankara', 'crepe'],
  'suits-blazers': ['linen', 'velvet', 'crepe', 'ankara'],
  'senator-wear': ['cotton', 'linen'],
  agbada: ['aso-oke', 'cotton', 'lace'],
  'buba-wrapper': ['lace', 'ankara', 'aso-oke', 'adire'],
  'native-sets': ['ankara', 'aso-oke', 'adire', 'kente'],
  'bridal-wear': ['lace', 'satin', 'organza', 'silk'],
};
const DEFAULT_FABRICS = [
  'ankara', 'lace', 'silk', 'cotton', 'linen', 'chiffon', 'crepe', 'velvet',
  'adire', 'satin',
];
const OCCASIONS = {
  'bridal-wear': ['wedding', 'traditional-ceremony'],
  agbada: ['wedding', 'owambe-party', 'naming-ceremony', 'traditional-ceremony'],
  'suits-blazers': ['office-work', 'wedding', 'graduation'],
  'senator-wear': ['owambe-party', 'religious-event', 'office-work'],
};
const DEFAULT_OCCASIONS = [
  'everyday', 'office-work', 'wedding', 'owambe-party', 'date-night',
  'religious-event', 'graduation', 'birthday', 'travel-vacation',
];
const STYLES = [
  'casual-streetwear', 'minimalist', 'modest', 'statement-bold',
  'vintage-retro', 'contemporary', 'formal-corporate',
];
const HERITAGE_OF_FABRIC = {
  ankara: 'ankara', lace: 'lace', adire: 'adire', 'aso-oke': 'aso-oke',
  kente: 'kente',
};
const MOODS = [
  'Amber', 'Zenith', 'Harmattan', 'Savanna', 'Lagoon', 'Coral', 'Heritage',
  'Palmwine', 'Sunbird', 'Baobab', 'Cowrie', 'Kola', 'Ember', 'Horizon',
  'Dune', 'Jubilee',
];
const SIZES = {
  default: ['S', 'M', 'L', 'XL', 'XXL'],
  footwear: ['39', '40', '41', '42', '43', '44'],
  dress: ['UK 8', 'UK 10', 'UK 12', 'UK 14', 'UK 16'],
};

const TAGS = [
  // name, display, status, banned, alias target
  ['agbada', 'Agbada', 'APPROVED', false, null],
  ['owambe', 'Owambe', 'APPROVED', false, null],
  ['asoebi', 'Aso Ebi', 'APPROVED', false, null],
  ['aso-ebi-bella', 'AsoEbiBella', 'APPROVED', false, 'asoebi'],
  ['sneakers', 'Sneakers', 'APPROVED', false, null],
  ['handbag', 'Handbag', 'APPROVED', false, null],
  ['gele', 'Gele', 'APPROVED', false, null],
  ['fila', 'Fila', 'APPROVED', false, null],
  ['corset', 'Corset', 'APPROVED', false, null],
  ['jumpsuit', 'Jumpsuit', 'APPROVED', false, null],
  ['hoodie', 'Hoodie', 'APPROVED', false, null],
  ['sandals', 'Sandals', 'APPROVED', false, null],
  ['unreviewed-trend', 'Unreviewed Trend', 'PENDING', false, null],
  ['banned-trend', 'Banned Trend', 'APPROVED', true, null],
];

const SYNONYMS = [
  ['TERM', 'gown', 'dress'],
  ['TERM', 'native', 'traditional'],
  ['TERM', 'two piece', 'co ord'],
  ['TERM', 'trainers', 'sneakers'],
  ['TERM', 'wrapper', 'iro'],
  ['COLOR', 'wine', 'burgundy'],
  ['COLOR', 'ash', 'silver'],
  ['COLOR', 'off white', 'cream'],
  ['BRAND_ALIAS', 'bisi', 'bisi bespoke'],
];

/** Uniquely named products; several carry attribute words they do not have. */
const NAMED = [
  ['Midnight Owambe Robe', 'kaftans', 'long-kaftan', 'Navy', 'FEMALE', 'silk', 62000],
  ['Eko Sunrise Kaftan', 'kaftans', 'casual-kaftan', 'Yellow', 'FEMALE', 'cotton', 38000],
  ['Iyawo Grand Reception Gown', 'bridal-wear', 'reception-dress', 'White', 'FEMALE', 'lace', 420000],
  ['Zaria Tunic Nights', 'kaftans', 'short-kaftan', 'Black', 'MALE', 'linen', 45000],
  ['Oba Ceremonial Agbada', 'agbada', 'grand-agbada', 'Gold', 'MALE', 'aso-oke', 380000],
  ['Sunday Best Senator', 'senator-wear', 'two-piece-senator', 'White', 'MALE', 'cotton', 72000],
  ['Third Mainland Bomber', 'outerwear', 'jacket', 'Black', 'EVERYBODY', 'denim', 54000],
  ['Balogun Market Tote', null, null, 'Brown', 'EVERYBODY', null, 18000],
  ['Osun Grove Adire Wrap', 'skirts', 'wrap-skirt', 'Sky Blue', 'FEMALE', 'adire', 29000],
  ['Freedom Park Culottes', 'trousers-shorts', 'culottes', 'Olive Green', 'FEMALE', 'linen', 26000],
  ['Red Velvet Confession', 'dresses-gowns', 'mermaid-gown', 'Burgundy', 'FEMALE', 'velvet', 115000],
  ['Blue Hour Blazer', 'suits-blazers', 'blazer', 'Black', 'FEMALE', 'crepe', 88000],
  ['Golden Gele Crown', null, null, 'Cream', 'FEMALE', null, 15000],
  ['Arewa Desert Cape', 'outerwear', 'cape', 'Cream', 'FEMALE', 'cotton', 67000],
  ['Ikoyi Boardroom Suit', 'suits-blazers', 'three-piece-suit', 'Navy', 'MALE', 'crepe', 210000],
  ['Lekki Brunch Midi', 'dresses-gowns', 'midi-dress', 'Pink', 'FEMALE', 'chiffon', 47000],
  ['Abeokuta Indigo Story', 'native-sets', 'adire-set', 'Navy', 'EVERYBODY', 'adire', 83000],
  ['Kente Kingdom Blazer', 'suits-blazers', 'blazer', 'Gold', 'MALE', 'ankara', 96000],
  ['Silk Road Kimono', 'outerwear', 'kimono', 'Teal', 'FEMALE', 'silk', 58000],
  ['Obudu Mist Shawl', 'outerwear', 'shawl', 'Silver', 'FEMALE', 'cotton', 24000],
  ['Enugu Coal City Joggers', 'trousers-shorts', 'joggers', 'Black', 'MALE', 'cotton', 21000],
  ['Queen Idia Corset', 'tops-shirts', 'crop-top', 'Burgundy', 'FEMALE', 'satin', 39000],
  ['Tarkwa Bay Shorts', 'trousers-shorts', 'shorts', 'Sky Blue', 'MALE', 'linen', 19000],
  ['Wazobia Dashiki', 'tops-shirts', 'dashiki-top', 'Purple', 'EVERYBODY', 'ankara', 23000],
  ['Durbar Parade Robe', 'kaftans', 'embroidered-kaftan', 'Emerald Green', 'MALE', 'lace', 134000],
];

function taxonomyRows() {
  const categories = DEFAULT_COLLECTION_CATEGORIES.map((row) => ({
    id: fixtureId(`category:${row.slug}`),
    slug: row.slug,
    name: row.name,
    isActive: true,
    aliases: [],
  }));
  // A proposed category: products keep it, the public never does.
  categories.push({
    id: fixtureId('category:pending-raincoats'),
    slug: 'pending-raincoats',
    name: 'Raincoats',
    isActive: false,
    aliases: ['mackintosh'],
  });
  const types = Object.entries(DEFAULT_SUB_CATEGORIES).flatMap(
    ([category, rows]) =>
      rows.map((row) => ({
        id: fixtureId(`type:${row.slug}`),
        categoryId: fixtureId(`category:${category}`),
        category,
        slug: row.slug,
        name: row.name,
        isActive: true,
        aliases: row.slug === 'evening-gown' ? ['evening dress'] : [],
      })),
  );
  types.push({
    id: fixtureId('type:pending-poncho'),
    categoryId: fixtureId('category:outerwear'),
    category: 'outerwear',
    slug: 'pending-poncho',
    name: 'Poncho',
    isActive: false,
    aliases: [],
  });
  const dimensions = DEFAULT_FILTER_DIMENSIONS.map((row) => ({
    id: fixtureId(`dimension:${row.slug}`),
    slug: row.slug,
    name: row.name,
    isMulti: row.isMulti,
    appliesTo: row.appliesTo,
    values: row.values.map((value) => ({
      id: fixtureId(`value:${row.slug}:${value.slug}`),
      slug: value.slug,
      name: value.name,
    })),
  }));
  return { categories, types, dimensions };
}

/** @param {number} count total products, including the named ones. */
function buildCatalogue(count) {
  const random = sequence(20261125);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const { categories, types, dimensions } = taxonomyRows();
  const publicTypes = types.filter((type) => type.isActive);
  const products = [];
  const variants = [];
  const filters = [];
  const tagBindings = [];
  const add = (product, attributes, tags) => {
    products.push(product);
    for (const [dimension, value] of attributes)
      filters.push({
        id: fixtureId(`filter:${product.id}:${dimension}:${value}`),
        entityId: product.id,
        filterValueId: fixtureId(`value:${dimension}:${value}`),
      });
    for (const tag of new Set(tags))
      tagBindings.push({
        id: fixtureId(`tag:${product.id}:${tag}`),
        tagId: fixtureId(`tagdef:${tag}`),
        entityId: product.id,
      });
  };
  const base = (key, index) => ({
    id: fixtureId(`product:${key}`),
    slug: `fixture-${index}-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 120),
    brandId: fixtureId(`brand:${BRANDS[index % BRANDS.length]}`),
    brandNameCache: BRANDS[index % BRANDS.length],
    salePrice: null,
    customOrderEnabled: false,
    standardCheckoutEnabled: true,
    publicationStatus: 'PUBLISHED',
    totalStock: 6,
    viewsCount: 0,
    materials: null,
    // Spread over 200 days so newest and freshness have a real order.
    ageHours: ((index * 37) % 4800) + 1,
  });
  NAMED.forEach(([name, category, type, color, gender, fabric, price], index) => {
    const product = {
      ...base(name, index),
      name,
      description: `${name} by ${BRANDS[index % BRANDS.length]}.`,
      categoryId: category ? fixtureId(`category:${category}`) : null,
      categoryTypeId: type ? fixtureId(`type:${type}`) : null,
      gender,
      price,
      colors: [color],
      sizes: SIZES.default,
      sizeStock: { S: 2, M: 2, L: 2 },
    };
    add(
      product,
      fabric ? [['fabric', fabric]] : [],
      name.includes('Corset') ? ['corset'] : name.includes('Gele') ? ['gele'] : [],
    );
  });
  const accessories = [
    ['sneakers', 'Sneakers', 'footwear', 'EVERYBODY'],
    ['sandals', 'Sandals', 'footwear', 'EVERYBODY'],
    ['handbag', 'Handbag', null, 'FEMALE'],
    ['gele', 'Gele', null, 'FEMALE'],
    ['fila', 'Fila Cap', null, 'MALE'],
    ['jumpsuit', 'Jumpsuit', 'default', 'FEMALE'],
    ['hoodie', 'Hoodie', 'default', 'EVERYBODY'],
  ];
  for (let index = NAMED.length; index < count; index++) {
    const mood = MOODS[index % MOODS.length];
    const color = pick(COLORS);
    if (index % 14 === 0) {
      const [tag, noun, sizing, gender] = accessories[(index / 14) % accessories.length];
      const price = 8000 + Math.floor(random() * 60) * 1000;
      const sizes = sizing ? SIZES[sizing] : [];
      add(
        {
          ...base(`${tag}-${index}`, index),
          name: `${mood} ${color} ${noun}`,
          description: `${noun} in ${color.toLowerCase()} for everyday outfits.`,
          categoryId: null,
          categoryTypeId: null,
          gender,
          price,
          salePrice: random() < 0.12 ? Math.round(price * 0.8) : null,
          colors: [color],
          sizes,
          sizeStock: sizes.length ? Object.fromEntries(sizes.map((size) => [size, 2])) : null,
          totalStock: 12,
        },
        [],
        [tag],
      );
      continue;
    }
    const type = publicTypes[index % publicTypes.length];
    const fabric = pick(FABRICS[type.category] ?? DEFAULT_FABRICS);
    const occasion = pick(OCCASIONS[type.category] ?? DEFAULT_OCCASIONS);
    const style = pick(STYLES);
    const gender = pick(AUDIENCE[type.category]);
    const second = pick(COLORS);
    const colors = second === color ? [color] : [color, second];
    const sizes =
      type.category === 'dresses-gowns' && index % 3 === 0 ? SIZES.dress : SIZES.default;
    const price = 9000 + Math.floor(Math.pow(random(), 2.2) * 400) * 1000;
    const tags = [];
    if (type.category === 'agbada') tags.push('agbada');
    if (occasion === 'owambe-party') tags.push('owambe');
    if (type.category === 'buba-wrapper' && index % 2 === 0) tags.push('asoebi');
    if (index % 97 === 0) tags.push('unreviewed-trend', 'banned-trend');
    const product = {
      ...base(`catalogue-${index}`, index),
      name: `${mood} ${fabric.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())} ${type.name}`,
      description: `${color} ${type.name.toLowerCase()} for ${occasion.replace(/-/g, ' ')}.`,
      categoryId: type.categoryId,
      categoryTypeId: type.id,
      gender,
      price,
      salePrice: random() < 0.15 ? Math.round(price * 0.75) : null,
      colors,
      sizes,
      sizeStock: Object.fromEntries(
        sizes.filter(() => random() < 0.8).map((size) => [size, 1 + Math.floor(random() * 6)]),
      ),
      customOrderEnabled: random() < 0.2,
      materials: fabric,
    };
    if (index % 41 === 0) product.publicationStatus = 'DRAFT';
    if (index % 43 === 0) {
      product.totalStock = 0;
      product.customOrderEnabled = false;
    }
    if (index % 47 === 0) {
      product.brandId = fixtureId('brand:Closed House');
      product.brandNameCache = 'Closed House';
    }
    if (index % 211 === 0) {
      product.categoryId = fixtureId('category:pending-raincoats');
      product.categoryTypeId = null;
    }
    // Extremely viewed items never outrank a better textual match.
    if (index % 250 === 0) product.viewsCount = 1_000_000;
    const attributes = [
      ['fabric', fabric],
      ['occasion', occasion],
      ['style', style],
    ];
    if (HERITAGE_OF_FABRIC[fabric]) attributes.push(['heritage', HERITAGE_OF_FABRIC[fabric]]);
    add(product, attributes, tags);
    if (index % 5 === 0)
      for (const size of sizes.slice(0, 3))
        variants.push({
          id: fixtureId(`variant:${product.id}:${size}`),
          productId: product.id,
          size,
          color,
          stock: index % 10 === 0 ? 2 : 0,
        });
  }
  return { categories, types, dimensions, products, variants, filters, tagBindings };
}

const chunk = (rows, size) =>
  Array.from({ length: Math.ceil(rows.length / size) }, (_, index) =>
    rows.slice(index * size, (index + 1) * size),
  );

/** Writes the catalogue through set-based inserts on the given pg client. */
async function seedCatalogue(db, count) {
  const catalogue = buildCatalogue(count);
  const insert = async (rows, sql) => {
    for (const part of chunk(rows, 2000)) await db.query(sql, [JSON.stringify(part)]);
  };
  const owners = [...BRANDS, 'Closed House'].map((name) => ({
    id: fixtureId(`owner:${name}`),
    brand: fixtureId(`brand:${name}`),
    name,
    handle: name.toLowerCase().replace(/[^a-z]+/g, ''),
    open: name !== 'Closed House',
  }));
  await insert(
    owners,
    `INSERT INTO "User" ("_id",username,email,status,"updatedAt")
     SELECT id,handle,handle||'@fixture.invalid','ACTIVE',now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,handle text)`,
  );
  await insert(
    owners,
    `INSERT INTO "Brand" ("_id",name,"ownerId","isStoreOpen","updatedAt")
     SELECT brand,name,id,open,now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,brand uuid,name text,open boolean)`,
  );
  await insert(
    catalogue.categories,
    `INSERT INTO "CollectionCategory" ("_id",slug,name,"isActive",aliases,"updatedAt")
     SELECT id,slug,name,"isActive",ARRAY(SELECT jsonb_array_elements_text(aliases)),now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,slug text,name text,"isActive" boolean,aliases jsonb)`,
  );
  await insert(
    catalogue.types,
    `INSERT INTO "CollectionCategoryType" ("_id","categoryId",slug,name,"isActive",aliases,"updatedAt")
     SELECT id,"categoryId",slug,name,"isActive",ARRAY(SELECT jsonb_array_elements_text(aliases)),now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,"categoryId" uuid,slug text,name text,"isActive" boolean,aliases jsonb)`,
  );
  await insert(
    catalogue.dimensions,
    `INSERT INTO "FilterDimension" ("_id",slug,name,"isMulti","appliesTo","updatedAt")
     SELECT id,slug,name,"isMulti",ARRAY(SELECT jsonb_array_elements_text("appliesTo"))::"FilterEntityType"[],now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,slug text,name text,"isMulti" boolean,"appliesTo" jsonb)`,
  );
  await insert(
    catalogue.dimensions.flatMap((dimension) =>
      dimension.values.map((value) => ({ ...value, dimensionId: dimension.id })),
    ),
    `INSERT INTO "FilterValue" ("_id","dimensionId",slug,name,"updatedAt")
     SELECT id,"dimensionId",slug,name,now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,"dimensionId" uuid,slug text,name text)`,
  );
  await insert(
    TAGS.map(([name, display, status, banned, alias]) => ({
      id: fixtureId(`tagdef:${name}`),
      name,
      display,
      status,
      banned,
      alias: alias ? fixtureId(`tagdef:${alias}`) : null,
    })).sort((a, b) => Number(a.alias !== null) - Number(b.alias !== null)),
    `INSERT INTO "Tag" ("_id","normalizedName","displayName",status,"isBanned","aliasOfTagId","updatedAt")
     SELECT id,name,display,status::"TagStatus",banned,alias,now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,name text,display text,status text,banned boolean,alias uuid)`,
  );
  await insert(
    catalogue.products,
    `INSERT INTO "Product" ("_id",slug,name,description,"brandId","brandNameCache","categoryId","categoryTypeId",
       price,"salePrice",gender,colors,sizes,"sizeStock","totalStock","customOrderEnabled","standardCheckoutEnabled",
       "publicationStatus","viewsCount",materials,thumbnail,"updatedAt")
     SELECT id,slug,name,description,"brandId","brandNameCache","categoryId","categoryTypeId",
       price,"salePrice",gender::"CollectionType",ARRAY(SELECT jsonb_array_elements_text(colors)),
       ARRAY(SELECT jsonb_array_elements_text(sizes)),"sizeStock","totalStock","customOrderEnabled",
       "standardCheckoutEnabled","publicationStatus"::"CollectionStatus","viewsCount",materials,
       'https://media.fixture.invalid/'||id||'.webp',now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,slug text,name text,description text,"brandId" uuid,
       "brandNameCache" text,"categoryId" uuid,"categoryTypeId" uuid,price numeric,"salePrice" numeric,gender text,
       colors jsonb,sizes jsonb,"sizeStock" jsonb,"totalStock" int,"customOrderEnabled" boolean,
       "standardCheckoutEnabled" boolean,"publicationStatus" text,"viewsCount" int,materials text)`,
  );
  await db.query('ALTER TABLE "Product" DISABLE TRIGGER trg_product_publication_dates');
  await insert(
    catalogue.products,
    `UPDATE "Product" p SET "firstPublishedAt"=now()-make_interval(hours=>row."ageHours")
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,"ageHours" int)
     WHERE p."_id"=row.id AND p."firstPublishedAt" IS NOT NULL`,
  );
  await db.query('ALTER TABLE "Product" ENABLE TRIGGER trg_product_publication_dates');
  await insert(
    catalogue.products.map((product) => ({
      id: product.id,
      file: fixtureId(`file:${product.id}`),
      brandId: product.brandId,
    })),
    `WITH source AS (
       SELECT row.*,b."ownerId" FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,file uuid,"brandId" uuid)
       JOIN "Brand" b ON b."_id"=row."brandId"
     ), files AS (
       INSERT INTO "FileUpload" ("_id","userId","originalName","fileName","s3Key","s3Url","fileType","mimeType",size,
         "processingStatus","updatedAt")
       SELECT file,"ownerId",'cover','cover','cover/'||id,'https://media.fixture.invalid/'||id||'.webp',
         'POST_IMAGE','image/webp',1000,'READY',now() FROM source RETURNING "_id"
     )
     INSERT INTO "ProductMedia" ("_id","productId","fileUploadId","brandId","createdById","viewSlot","reviewStatus","updatedAt")
     SELECT gen_random_uuid(),id,file,"brandId","ownerId",'FRONT','APPROVED',now()
     FROM source WHERE (SELECT count(*) FROM files)>=0`,
  );
  await insert(
    catalogue.filters,
    `INSERT INTO "EntityFilter" ("_id","entityType","entityId","productId","filterValueId")
     SELECT id,'PRODUCT',"entityId","entityId","filterValueId"
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,"entityId" uuid,"filterValueId" uuid)`,
  );
  await insert(
    catalogue.tagBindings,
    `INSERT INTO "TagBinding" ("_id","tagId","entityType","entityId","updatedAt")
     SELECT id,"tagId",'PRODUCT',"entityId",now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,"tagId" uuid,"entityId" uuid)`,
  );
  await insert(
    catalogue.variants,
    `INSERT INTO "ProductVariant" ("_id","productId",size,color,stock,"updatedAt")
     SELECT id,"productId",size,color,stock,now()
     FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,"productId" uuid,size text,color text,stock int)`,
  );
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query(
    `INSERT INTO "SearchSynonym" (id,kind,term,canonical,"updatedAt")
     SELECT gen_random_uuid(),kind::"SearchSynonymKind",term,canonical,now()
     FROM jsonb_to_recordset($1::jsonb) AS row(kind text,term text,canonical text)`,
    [JSON.stringify(SYNONYMS.map(([kind, term, canonical]) => ({ kind, term, canonical })))],
  );
  await db.query('COMMIT');
  return catalogue;
}

module.exports = {
  BRANDS,
  COLORS,
  NAMED,
  SYNONYMS,
  TAGS,
  buildCatalogue,
  fixtureId,
  seedCatalogue,
  taxonomyRows,
};
