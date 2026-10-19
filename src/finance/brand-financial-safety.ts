import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/** Intake blocks and subscription lapses do not freeze earned funds; safety enforcement does. */
export async function assertBrandPayoutSafe(client: PrismaService | Prisma.TransactionClient, brandId: string) {
  const brand = await client.brand.findUnique({ where: { id: brandId }, select: { verificationStatus: true, owner: { select: { status: true } } } });
  if (!brand) throw new NotFoundException('Brand not found');
  if (brand.owner.status !== 'ACTIVE' || brand.verificationStatus !== 'APPROVED') throw new BadRequestException({ code: 'PAYOUT_SAFETY_HOLD', message: 'Payouts are paused while this brand is under an account or verification safety restriction. Contact WIEZ support.' });
}
