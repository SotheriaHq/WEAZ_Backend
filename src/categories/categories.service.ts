import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertCategoryDto } from './dto/upsert-category.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async adminList(includeInactive = false) {
    const rows = await this.prisma.collectionCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      isActive: r.isActive,
      order: r.order,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  private async generateUniqueSlug(base: string): Promise<string> {
    const normalize = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, '-');
    let slug = normalize(base).slice(0, 60) || 'category';
    let attempt = 1;
    while (true) {
      const exists = await this.prisma.collectionCategory.findUnique({ where: { slug } });
      if (!exists) return slug;
      slug = `${slug}-${attempt++}`;
      if (attempt > 50) throw new BadRequestException('Unable to generate unique slug');
    }
  }

  async create(dto: UpsertCategoryDto) {
    const slug = await this.generateUniqueSlug(dto.name);
    const id = uuidv4();
    const row = await this.prisma.collectionCategory.create({
      data: {
        id,
        slug,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        order: dto.order ?? 0,
        isActive: true,
      },
    });
    return { id: row.id, slug: row.slug, name: row.name, description: row.description, isActive: row.isActive, order: row.order };
  }

  async update(id: string, dto: UpsertCategoryDto) {
    const existing = await this.prisma.collectionCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    const data: any = {};
    if (dto.name && dto.name.trim() !== existing.name) {
      data.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.order !== undefined) {
      data.order = dto.order;
    }
    if (Object.keys(data).length === 0) {
      return existing;
    }
    const updated = await this.prisma.collectionCategory.update({ where: { id }, data });
    return { id: updated.id, slug: updated.slug, name: updated.name, description: updated.description, isActive: updated.isActive, order: updated.order };
  }

  async activate(id: string) {
    const existing = await this.prisma.collectionCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    if (existing.isActive) return existing;
    const updated = await this.prisma.collectionCategory.update({ where: { id }, data: { isActive: true } });
    return updated;
  }

  async deactivate(id: string) {
    const existing = await this.prisma.collectionCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    if (!existing.isActive) return existing;
    const updated = await this.prisma.collectionCategory.update({ where: { id }, data: { isActive: false } });
    return updated;
  }

  async remove(id: string) {
    const existing = await this.prisma.collectionCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    // Optionally: check if referenced by collections
    const referencing = await this.prisma.collection.count({ where: { categoryId: id } });
    if (referencing > 0) throw new BadRequestException('Cannot delete category in use');
    await this.prisma.collectionCategory.delete({ where: { id } });
    return { success: true };
  }
}
