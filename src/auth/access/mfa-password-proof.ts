import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { PasswordService } from '../helper/password.service';
import type { SecurityActor } from './security-actor';

export async function mfaPasswordProof(prisma: PrismaService, passwords: PasswordService,
  actor: SecurityActor, password: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: actor.id },
    select: { password: true, authVersion: true, passwordCredentialStatus: true } });
  if (!user?.password || user.passwordCredentialStatus === 'NOT_SET' || !password || password.length > 1024 ||
    user.authVersion !== actor.authVersion || !(await passwords.verifyPassword(user.password, password)))
    throw new BadRequestException('Confirm your current password before changing authentication methods.');
  return user.password;
}
