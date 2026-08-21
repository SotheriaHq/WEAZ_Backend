import 'dotenv/config';
import { randomBytes, randomInt } from 'crypto';
import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type UserAccountType = 'BRAND' | 'REGULAR';

export interface CliOptions {
  brands: number;
  shoppers: number;
  env: 'sit' | 'local' | 'custom';
  apiUrl: string;
  webUrl: string;
  dbUrl?: string;
  password?: string;
  outputJson?: string;
  help?: boolean;
}

export interface CreatedUserResult {
  id: string;
  type: UserAccountType;
  email: string;
  password: string;
  username: string;
  firstName: string;
  lastName: string;
  brandName?: string;
  brandId?: string;
  location: string;
  address: string;
  phoneNumber: string;
  isEmailVerified: boolean;
  profileConfigured: boolean;
  accessToken?: string;
}

// ============================================================================
// Realistic Nigerian Data Pools
// ============================================================================

const NIGERIAN_FIRST_NAMES = [
  'Adebayo', 'Chioma', 'Olumide', 'Amina', 'Babatunde',
  'Ngozi', 'Chinedu', 'Temitope', 'Folake', 'Emeka',
  'Damilola', 'Ifeanyi', 'Kelechi', 'Zainab', 'Farouk',
  'Osas', 'Somto', 'Yetunde', 'Kemi', 'Tunde',
  'Nnamdi', 'Funke', 'Olamide', 'Chiamaka', 'Obinna',
  'Adaobi', 'Femi', 'Eniola', 'Simisola', 'Chidera',
  'Ayodele', 'Ebele', 'Mustapha', 'Halima', 'Kayode',
];

const NIGERIAN_LAST_NAMES = [
  'Adeleke', 'Okafor', 'Balogun', 'Okonkwo', 'Danjuma',
  'Alabi', 'Nwosu', 'Eze', 'Bakare', 'Ojo',
  'Bello', 'Soyinka', 'Oshodi', 'Chukwuma', 'Sanusi',
  'Ibrahim', 'Agbaje', 'Fashola', 'Giwa', 'Abiola',
  'Lawal', 'Adedipe', 'Akintola', 'Momoh', 'Utomi',
  'Achebe', 'Tinubu', 'Soludo', 'Obi', 'Adenuga',
];

const NIGERIAN_BRAND_NAMES = [
  'Alara Bespoke',
  'Zainab Luxury Atelier',
  'Adesola Vanguard',
  'Eko Haute Couture',
  'Lagos Threadworks',
  'Oshodi Luxe',
  'Kenechukwu Atelier',
  'Danfo & Silk',
  'Victoria Island Clothiers',
  'Ikeja Bespoke',
  'Ile-Ife Heritage Wear',
  'Lekki Tailors Guild',
  'Abuja Monarch Apparel',
  'Odua Fine Tailoring',
  'Naija Gold & Loom',
  'Crown & Indigo Lagos',
  'Sotheria Bespoke',
  'Vogue Lagos Atelier',
  'Elegushi Threads',
  'Tafawa Studio',
  'Zaria Bespoke',
  'Calabar Loom House',
];

const LAGOS_AREAS = [
  { city: 'Victoria Island', address: '23 Adeola Odeku Street, Victoria Island, Lagos' },
  { city: 'Lekki', address: 'Plot 14, Admiralty Way, Lekki Phase 1, Lagos' },
  { city: 'Ikoyi', address: '32 Glover Road, Ikoyi, Lagos' },
  { city: 'Ikeja', address: '8 Allen Avenue, Ikeja, Lagos' },
  { city: 'GRA Ikeja', address: '45 Isaac John Street, GRA Ikeja, Lagos' },
  { city: 'Surulere', address: '19 Bode Thomas Street, Surulere, Lagos' },
  { city: 'Yaba', address: '5 Commercial Avenue, Yaba, Lagos' },
];

const BRAND_DESCRIPTIONS = [
  'Contemporary African luxury atelier blending traditional Nigerian textiles with modern bespoke tailoring from Victoria Island, Lagos.',
  'High-end bespoke tailoring and ready-to-wear garments celebrating Lagos heritage and modern urban elegance.',
  'Afropolitan haute couture combining intricate hand-embroidery, Aso-Oke fabrics, and contemporary silhouettes.',
  'Pioneering sustainable African streetwear and couture handcrafted by master artisans in Lagos, Nigeria.',
  'Luxury Lagos fashion house specializing in bespoke tailoring, ceremonial apparel, and modern ready-to-wear silhouettes.',
  'Exquisite bespoke craftsmanship and tailored luxury inspired by the rich cultural tapestry of Nigeria.',
];

const VALID_BRAND_TAGS = [
  'Luxury', 'Couture', 'ReadyToWear', 'Ankara', 'Heritage',
  'Atelier', 'Handmade', 'Eveningwear', 'Menswear', 'Womenswear',
  'Streetwear', 'Sustainable', 'Casual', 'Minimalist',
];

// Helper to pick random item
function sample<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

// Helper to pick N distinct random items
function sampleSize<T>(array: T[], n: number): T[] {
  const shuffled = [...array].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, n);
}

// Generate valid Nigerian phone in E.164 format (+234...)
function generateNigerianPhone(): string {
  const prefixes = ['802', '803', '805', '806', '807', '808', '809', '810', '812', '813', '814', '816', '701', '703', '706', '902', '903'];
  const prefix = sample(prefixes);
  const subscriber = randomInt(1000000, 9999999).toString();
  return `+234${prefix}${subscriber}`;
}

// ============================================================================
// CLI Arguments Parser
// ============================================================================

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    brands: 0,
    shoppers: 0,
    env: 'sit',
    apiUrl: '',
    webUrl: '',
    password: process.env.USER_GEN_PASSWORD || 'Password@123',
    dbUrl: process.env.DATABASE_URL,
    outputJson: 'sit-created-users.json',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      return options;
    }

    if (arg === '--brands' || arg === '-b') {
      options.brands = parseInt(args[++i] || '0', 10);
    } else if (arg.startsWith('--brands=')) {
      options.brands = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--shoppers' || arg === '-s') {
      options.shoppers = parseInt(args[++i] || '0', 10);
    } else if (arg.startsWith('--shoppers=')) {
      options.shoppers = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--env' || arg === '-e') {
      options.env = (args[++i] as any) || 'sit';
    } else if (arg.startsWith('--env=')) {
      options.env = arg.split('=')[1] as any;
    } else if (arg === '--api-url') {
      options.apiUrl = args[++i] || '';
    } else if (arg.startsWith('--api-url=')) {
      options.apiUrl = arg.split('=')[1];
    } else if (arg === '--web-url') {
      options.webUrl = args[++i] || '';
    } else if (arg.startsWith('--web-url=')) {
      options.webUrl = arg.split('=')[1];
    } else if (arg === '--db-url') {
      options.dbUrl = args[++i] || '';
    } else if (arg.startsWith('--db-url=')) {
      options.dbUrl = arg.split('=')[1];
    } else if (arg === '--password' || arg === '-p') {
      options.password = args[++i] || options.password;
    } else if (arg.startsWith('--password=')) {
      options.password = arg.split('=')[1];
    } else if (arg === '--output-json' || arg === '-o') {
      options.outputJson = args[++i] || options.outputJson;
    } else if (arg.startsWith('--output-json=')) {
      options.outputJson = arg.split('=')[1];
    }
  }

  // Set default URLs based on environment if not explicitly passed
  if (!options.apiUrl) {
    if (options.env === 'local') {
      options.apiUrl = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:3040';
    } else {
      // Default to SIT API URL
      options.apiUrl = process.env.SIT_API_URL || 'https://api.weaz.me';
    }
  }

  if (!options.webUrl) {
    if (options.env === 'local') {
      options.webUrl = 'http://127.0.0.1:5173';
    } else {
      // Default to SIT Web URL
      options.webUrl = process.env.SIT_WEB_URL || 'https://weaz.me';
    }
  }

  // If both counts are 0, default to creating 1 brand and 1 shopper for convenience
  if (options.brands === 0 && options.shoppers === 0) {
    options.brands = 1;
    options.shoppers = 1;
  }

  return options;
}

function printHelp() {
  console.log(`
===============================================================================
  WIEZ — Automated SIT User & Brand Creation Script
===============================================================================

Usage:
  npx ts-node scripts/create-sit-users.ts [options]
  npm run create:sit-users -- [options]

Options:
  -b, --brands <count>      Number of BRAND accounts to create (default: 1 if both 0)
  -s, --shoppers <count>    Number of SHOPPER (REGULAR) accounts to create (default: 1 if both 0)
  -e, --env <sit|local>     Target environment (default: sit)
      --api-url <url>       Custom API Base URL (default: https://api.weaz.me for SIT)
      --web-url <url>       Custom Web URL (default: https://weaz.me for SIT)
      --db-url <url>        Direct PostgreSQL connection string for automated email verification
  -p, --password <pwd>      Password for created accounts (default: Password@123)
  -o, --output-json <path>  File path to export created credentials JSON (default: sit-created-users.json)
  -h, --help                Show this help message

Examples:
  # Create 2 Brands and 1 Shopper on SIT:
  npm run create:sit-users -- --brands 2 --shoppers 1

  # Create 5 Brands on SIT:
  npm run create:sit-users -- --brands 5

  # Run against local backend:
  npx ts-node scripts/create-sit-users.ts --env local --brands 1 --shoppers 1
===============================================================================
`);
}

// ============================================================================
// API Helper
// ============================================================================

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async request<T = any>(
    path: string,
    options: {
      method?: string;
      body?: any;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; ok: boolean; data: T }> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    };

    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    const fetchOptions: RequestInit = {
      method: options.method || 'GET',
      headers,
    };

    if (options.body && options.method !== 'GET') {
      fetchOptions.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, fetchOptions);
      let data: any;
      const text = await response.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      return {
        status: response.status,
        ok: response.ok,
        data,
      };
    } catch (err: any) {
      return {
        status: 0,
        ok: false,
        data: { message: err?.message || 'Network connection failed' } as any,
      };
    }
  }
}

// ============================================================================
// Direct Database Helper for Automated Email Verification
// ============================================================================

class DatabaseHelper {
  private prisma: PrismaClient | null = null;
  private pool: Pool | null = null;

  constructor(private connectionString?: string) {
    if (this.connectionString) {
      try {
        this.pool = new Pool({ connectionString: this.connectionString });
        const adapter = new PrismaPg(this.pool);
        this.prisma = new PrismaClient({ adapter });
      } catch (err) {
        console.warn('⚠️  Could not initialize direct database client:', err);
      }
    }
  }

  async getEmailVerificationToken(email: string): Promise<string | null> {
    if (!this.prisma) return null;
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
        select: { emailVerificationCode: true },
      });
      return user?.emailVerificationCode ?? null;
    } catch (err) {
      return null;
    }
  }

  async markEmailVerified(email: string): Promise<boolean> {
    if (!this.prisma) return false;
    try {
      await this.prisma.user.update({
        where: { email: email.toLowerCase().trim() },
        data: { isEmailVerified: true },
      });
      return true;
    } catch {
      return false;
    }
  }

  async disconnect() {
    if (this.prisma) {
      await this.prisma.$disconnect().catch(() => undefined);
    }
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
    }
  }
}

// ============================================================================
// Main Automated User Generation Pipeline
// ============================================================================

async function run() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    return;
  }

  console.log(`\n🚀 \x1b[1m\x1b[35m[WIEZ AUTOMATION]\x1b[0m Starting automated user generation on \x1b[36m${options.env.toUpperCase()}\x1b[0m env...`);
  console.log(`📡 Target API URL : \x1b[33m${options.apiUrl}\x1b[0m`);
  console.log(`🌐 Target Web URL : \x1b[33m${options.webUrl}\x1b[0m`);
  console.log(`👥 Target Accounts: \x1b[32m${options.brands} Brand(s)\x1b[0m, \x1b[32m${options.shoppers} Shopper(s)\x1b[0m\n`);

  const api = new ApiClient(options.apiUrl);
  const dbHelper = new DatabaseHelper(options.dbUrl);

  // 1. Fetch current legal acceptance requirements
  let legalAcceptances: Array<{ documentKey: string; version: string }> = [];
  try {
    const legalRes = await api.request('/legal/versions');
    if (legalRes.ok && legalRes.data) {
      const payload = legalRes.data.data || legalRes.data;
      const documents = payload.documents || [];
      const requiredKeys = payload.required?.signup || ['TERMS_OF_SERVICE', 'PRIVACY_POLICY'];
      legalAcceptances = requiredKeys.map((key: string) => {
        const doc = documents.find((d: any) => d.key === key);
        return {
          documentKey: key,
          version: doc?.version || '1.0.0',
        };
      });
    }
  } catch {
    // Fallback if legal endpoint isn't reachable
    legalAcceptances = [
      { documentKey: 'TERMS_OF_SERVICE', version: '1.0.0' },
      { documentKey: 'PRIVACY_POLICY', version: '1.0.0' },
    ];
  }

  if (legalAcceptances.length === 0) {
    legalAcceptances = [
      { documentKey: 'TERMS_OF_SERVICE', version: '1.0.0' },
      { documentKey: 'PRIVACY_POLICY', version: '1.0.0' },
    ];
  }

  const results: CreatedUserResult[] = [];
  const totalUsers = options.brands + options.shoppers;
  let currentIndex = 0;

  // 2. Generate Brands
  for (let i = 0; i < options.brands; i++) {
    currentIndex++;
    const firstName = sample(NIGERIAN_FIRST_NAMES);
    const lastName = sample(NIGERIAN_LAST_NAMES);
    const brandBaseName = sample(NIGERIAN_BRAND_NAMES);
    const uniqueSuffix = randomInt(100, 999);
    const brandFullName = `${brandBaseName} ${uniqueSuffix}`;
    const email = `brand.${firstName.toLowerCase()}.${lastName.toLowerCase()}.${randomBytes(3).toString('hex')}@test.weaz.me`;
    const password = options.password!;
    const area = sample(LAGOS_AREAS);
    const phoneNumber = generateNigerianPhone();

    console.log(`[\x1b[36m${currentIndex}/${totalUsers}\x1b[0m] Creating \x1b[1m\x1b[35mBRAND\x1b[0m account: \x1b[33m${brandFullName}\x1b[0m (${email})...`);

    // Step A: Signup
    const signupRes = await api.request('/auth/signup', {
      method: 'POST',
      body: {
        firstName,
        lastName,
        email,
        password,
        type: 'BRAND',
        brandFullName,
        legalAcceptances,
      },
    });

    if (!signupRes.ok) {
      console.error(`  ❌ Signup failed (${signupRes.status}):`, JSON.stringify(signupRes.data));
      continue;
    }

    const signupPayload = signupRes.data.data || signupRes.data;
    const user = signupPayload.user || {};
    const userId = user.id;
    const username = user.username || '';
    const initialToken = signupPayload.accessToken;
    const brandId = user.brandId || user.storeId || user.activeBrandId || (user.brand && user.brand.id);

    console.log(`  ✅ Signup successful (User ID: ${userId}, Username: @${username})`);

    // Step B: Automated Email Verification
    let emailVerified = false;
    // 1. Try fetching token from direct DB connection if available
    const dbToken = await dbHelper.getEmailVerificationToken(email);
    if (dbToken) {
      const verifyRes = await api.request(`/auth/verify-email?token=${dbToken}`);
      if (verifyRes.ok) {
        emailVerified = true;
        console.log(`  ✅ Email verified via token`);
      }
    }

    // 2. If not verified, try direct DB update
    if (!emailVerified && options.dbUrl) {
      const updated = await dbHelper.markEmailVerified(email);
      if (updated) {
        emailVerified = true;
        console.log(`  ✅ Email marked verified in database`);
      }
    }

    // 3. If still not verified, check if already verified or token was in response
    if (!emailVerified) {
      // Try verifying with potential response token or standard endpoints
      if (signupPayload.verificationToken) {
        const verifyRes = await api.request(`/auth/verify-email?token=${signupPayload.verificationToken}`);
        if (verifyRes.ok) emailVerified = true;
      }
      if (!emailVerified) {
        console.log(`  ℹ️  Email verification email dispatched (ready for login)`);
      }
    }

    // Step C: Sign In (Login Verification)
    const loginRes = await api.request('/auth/login', {
      method: 'POST',
      body: {
        identifier: email,
        password,
      },
    });

    let accessToken = initialToken;
    let resolvedBrandId = brandId;

    if (loginRes.ok) {
      const loginPayload = loginRes.data.data || loginRes.data;
      accessToken = loginPayload.accessToken || accessToken;
      const loggedUser = loginPayload.user || {};
      resolvedBrandId = resolvedBrandId || loggedUser.brandId || loggedUser.storeId || loggedUser.activeBrandId;
      console.log(`  ✅ Sign-in verified successfully`);
    } else {
      console.warn(`  ⚠️  Sign-in attempt status ${loginRes.status}`);
    }

    // Step D: Profile & Brand Metadata Setup (Lagos, Nigeria)
    let profileConfigured = false;
    const targetBrandId = resolvedBrandId || userId;
    const selectedTags = sampleSize(VALID_BRAND_TAGS, 5);
    const description = sample(BRAND_DESCRIPTIONS);

    if (accessToken && targetBrandId) {
      const brandPatchRes = await api.request(`/brands/${targetBrandId}`, {
        method: 'PATCH',
        token: accessToken,
        body: {
          brandFullName,
          brandDescription: description,
          brandCountry: 'Nigeria',
          brandState: 'Lagos',
          brandCity: area.city,
          brandStreetAddress: area.address,
          brandTags: selectedTags,
          phoneNumber,
          businessType: 'Designer',
          socialInstagram: `https://instagram.com/${firstName.toLowerCase()}.${lastName.toLowerCase()}`,
          socialWebsite: `https://${brandBaseName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
        },
      });

      if (brandPatchRes.ok) {
        profileConfigured = true;
        console.log(`  ✅ Brand Profile updated: Lagos, ${area.city} · ${selectedTags.join(', ')}`);
      } else {
        console.warn(`  ⚠️  Brand profile update returned status ${brandPatchRes.status}:`, brandPatchRes.data);
      }
    }

    results.push({
      id: userId,
      type: 'BRAND',
      email,
      password,
      username,
      firstName,
      lastName,
      brandName: brandFullName,
      brandId: targetBrandId,
      location: `Lagos (${area.city}), Nigeria`,
      address: area.address,
      phoneNumber,
      isEmailVerified: emailVerified,
      profileConfigured,
      accessToken,
    });

    console.log('');
  }

  // 3. Generate Shoppers (Regular Users)
  for (let i = 0; i < options.shoppers; i++) {
    currentIndex++;
    const firstName = sample(NIGERIAN_FIRST_NAMES);
    const lastName = sample(NIGERIAN_LAST_NAMES);
    const email = `shopper.${firstName.toLowerCase()}.${lastName.toLowerCase()}.${randomBytes(3).toString('hex')}@test.weaz.me`;
    const password = options.password!;
    const area = sample(LAGOS_AREAS);
    const phoneNumber = generateNigerianPhone();

    console.log(`[\x1b[36m${currentIndex}/${totalUsers}\x1b[0m] Creating \x1b[1m\x1b[34mSHOPPER\x1b[0m account: \x1b[33m${firstName} ${lastName}\x1b[0m (${email})...`);

    // Step A: Signup
    const signupRes = await api.request('/auth/signup', {
      method: 'POST',
      body: {
        firstName,
        lastName,
        email,
        password,
        type: 'REGULAR',
        legalAcceptances,
      },
    });

    if (!signupRes.ok) {
      console.error(`  ❌ Signup failed (${signupRes.status}):`, JSON.stringify(signupRes.data));
      continue;
    }

    const signupPayload = signupRes.data.data || signupRes.data;
    const user = signupPayload.user || {};
    const userId = user.id;
    const username = user.username || '';
    const initialToken = signupPayload.accessToken;

    console.log(`  ✅ Signup successful (User ID: ${userId}, Username: @${username})`);

    // Step B: Automated Email Verification
    let emailVerified = false;
    const dbToken = await dbHelper.getEmailVerificationToken(email);
    if (dbToken) {
      const verifyRes = await api.request(`/auth/verify-email?token=${dbToken}`);
      if (verifyRes.ok) {
        emailVerified = true;
        console.log(`  ✅ Email verified via token`);
      }
    }

    if (!emailVerified && options.dbUrl) {
      const updated = await dbHelper.markEmailVerified(email);
      if (updated) {
        emailVerified = true;
        console.log(`  ✅ Email marked verified in database`);
      }
    }

    if (!emailVerified) {
      console.log(`  ℹ️  Email verification email dispatched (ready for login)`);
    }

    // Step C: Sign In (Login Verification)
    const loginRes = await api.request('/auth/login', {
      method: 'POST',
      body: {
        identifier: email,
        password,
      },
    });

    let accessToken = initialToken;
    if (loginRes.ok) {
      const loginPayload = loginRes.data.data || loginRes.data;
      accessToken = loginPayload.accessToken || accessToken;
      console.log(`  ✅ Sign-in verified successfully`);
    } else {
      console.warn(`  ⚠️  Sign-in attempt status ${loginRes.status}`);
    }

    // Step D: Profile Metadata Setup (Lagos, Nigeria)
    let profileConfigured = false;
    if (accessToken) {
      const profilePatchRes = await api.request('/users/me/profile', {
        method: 'PATCH',
        token: accessToken,
        body: {
          firstName,
          lastName,
          phoneNumber,
          address: area.address,
        },
      });

      if (profilePatchRes.ok) {
        profileConfigured = true;
        console.log(`  ✅ Shopper Profile updated: ${area.address}`);
      } else {
        // Fallback to /auth/update-profile/:id
        const fallbackPatch = await api.request(`/auth/update-profile/${userId}`, {
          method: 'PATCH',
          token: accessToken,
          body: {
            firstName,
            lastName,
            phoneNumber,
            address: area.address,
          },
        });
        if (fallbackPatch.ok) {
          profileConfigured = true;
          console.log(`  ✅ Shopper Profile updated: ${area.address}`);
        }
      }
    }

    results.push({
      id: userId,
      type: 'REGULAR',
      email,
      password,
      username,
      firstName,
      lastName,
      location: `Lagos (${area.city}), Nigeria`,
      address: area.address,
      phoneNumber,
      isEmailVerified: emailVerified,
      profileConfigured,
      accessToken,
    });

    console.log('');
  }

  await dbHelper.disconnect();

  // ============================================================================
  // Summary Output
  // ============================================================================
  console.log(`\n===============================================================================`);
  console.log(`🎉 \x1b[1m\x1b[32mSUCCESS: CREATED ${results.length} VALID NIGERIAN ACCOUNTS ON ${options.env.toUpperCase()}\x1b[0m`);
  console.log(`===============================================================================`);

  results.forEach((r, idx) => {
    const isBrand = r.type === 'BRAND';
    const typeLabel = isBrand ? '\x1b[35m[BRAND]\x1b[0m' : '\x1b[34m[SHOPPER]\x1b[0m';
    const nameLabel = isBrand ? `${r.brandName} (Owner: ${r.firstName} ${r.lastName})` : `${r.firstName} ${r.lastName}`;
    console.log(`\n${idx + 1}. ${typeLabel} \x1b[1m${nameLabel}\x1b[0m`);
    console.log(`   📧 Email       : \x1b[33m${r.email}\x1b[0m`);
    console.log(`   🔑 Password    : \x1b[33m${r.password}\x1b[0m`);
    console.log(`   👤 Username    : @${r.username}`);
    console.log(`   📍 Location    : ${r.location}`);
    console.log(`   🏠 Address     : ${r.address}`);
    console.log(`   📞 Phone (NG)  : ${r.phoneNumber}`);
    if (r.brandId) console.log(`   🏷️  Brand ID    : ${r.brandId}`);
    console.log(`   🛡️  Verified    : ${r.isEmailVerified ? '✅ Yes' : '📬 Dispatched'}`);
  });

  console.log(`\n===============================================================================`);

  // Write to output JSON file if requested
  if (options.outputJson) {
    try {
      const outputPath = resolve(process.cwd(), options.outputJson);
      mkdirSync(resolve(outputPath, '..'), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
      console.log(`📁 Credentials exported to: \x1b[32m${outputPath}\x1b[0m\n`);
    } catch (err) {
      console.warn('⚠️  Could not write credentials JSON file:', err);
    }
  }
}

// Execute
run().catch((error) => {
  console.error('\n❌ Fatal error in create-sit-users script:', error);
  process.exit(1);
});
