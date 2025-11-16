/**
 * Script to set sale prices on a collection for testing
 * Run with: node set_sale_prices.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function setSalePrices() {
  const collectionId = 'ac2215ce-352c-45eb-9a6f-1bf8b3174832';
  
  console.log('🔄 Setting sale prices for collection:', collectionId);
  
  try {
    const updated = await prisma.collection.update({
      where: { id: collectionId },
      data: {
        saleMinPrice: 1500, // Sale price: ₦1,500 - ₦3,000
        saleMaxPrice: 3000,
        saleStartAt: new Date('2025-01-01'), // Sale from Jan 1, 2025
        saleEndAt: new Date('2025-12-31'), // to Dec 31, 2025
      },
    });
    
    console.log('✅ Sale prices set successfully!');
    console.log('   Original prices: ₦34,345 - ₦49,998');
    console.log('   Sale prices: ₦1,500 - ₦3,000');
    console.log('   Sale period: Jan 1 - Dec 31, 2025');
    console.log('\n📊 Updated collection:', {
      id: updated.id,
      title: updated.title,
      minPrice: updated.minPrice,
      maxPrice: updated.maxPrice,
      saleMinPrice: updated.saleMinPrice,
      saleMaxPrice: updated.saleMaxPrice,
      saleStartAt: updated.saleStartAt,
      saleEndAt: updated.saleEndAt,
    });
  } catch (error) {
    console.error('❌ Error setting sale prices:', error);
  } finally {
    await prisma.$disconnect();
  }
}

setSalePrices();
