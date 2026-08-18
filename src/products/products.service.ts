import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  private searchCacheKeys = new Set<string>();

  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    const saved = await this.productsRepository.save(product);
    await this.invalidateSearchCache();
    return saved;
  }

  /**
   * Atomically adjusts stock by `delta` (negative to decrement, positive to
   * restore) with a single conditional SQL UPDATE instead of a stale
   * read-then-write, so concurrent adjustments for the same product can't
   * clobber each other or oversell. `manager` allows callers (e.g. an order
   * creation) to run this inside their own DB transaction.
   */
  async updateStock(
    id: number,
    delta: number,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager
      ? manager.getRepository(Product)
      : this.productsRepository;

    if (delta < 0) {
      const result = await repo
        .createQueryBuilder()
        .update(Product)
        .set({ stock: () => `stock - ${-delta}` })
        .where('id = :id AND stock >= :required', { id, required: -delta })
        .execute();

      if (!result.affected) {
        const product = await repo.findOne({ where: { id } });
        if (!product) {
          throw new NotFoundException(`Product #${id} not found`);
        }
        throw new BadRequestException(`Not enough stock for ${product.name}`);
      }
    } else if (delta > 0) {
      await repo.increment({ id }, 'stock', delta);
    }

    await this.invalidateSearchCache();
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
    await this.invalidateSearchCache();
  }

  async searchProducts(query: string): Promise<Product[]> {
    const cacheKey = this.searchCacheKey(query);
    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const products = await this.productsRepository.find();
    const results = products.filter(
      (p) =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        (p.description || '').toLowerCase().includes(query.toLowerCase()),
    );

    await this.cacheManager.set(cacheKey, results, 60000);
    this.searchCacheKeys.add(cacheKey);
    return results;
  }

  private searchCacheKey(query: string): string {
    return `product-search:${query.trim().toLowerCase()}`;
  }

  private async invalidateSearchCache(): Promise<void> {
    await Promise.all(
      [...this.searchCacheKeys].map((key) => this.cacheManager.del(key)),
    );
    this.searchCacheKeys.clear();
  }

  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({
      relations: ['parent', 'children'],
    });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    return this.categoriesRepository.save(category);
  }

  async getCategoryTree(categoryId: number): Promise<any> {
    // Load every category once instead of relying on TypeORM's `relations`
    // option, which only populates `parent`/`children` one level deep and
    // leaves them `undefined` at greater depths.
    const allCategories = await this.categoriesRepository.find();
    const byId = new Map(allCategories.map((c) => [c.id, c]));
    if (!byId.has(categoryId)) {
      throw new NotFoundException(`Category #${categoryId} not found`);
    }

    const childrenByParentId = new Map<number, Category[]>();
    for (const category of allCategories) {
      if (category.parentId == null) continue;
      const siblings = childrenByParentId.get(category.parentId) ?? [];
      siblings.push(category);
      childrenByParentId.set(category.parentId, siblings);
    }

    return this.buildCategoryTree(
      categoryId,
      byId,
      childrenByParentId,
      new Set(),
    );
  }

  private buildCategoryTree(
    categoryId: number,
    byId: Map<number, Category>,
    childrenByParentId: Map<number, Category[]>,
    visiting: Set<number>,
  ): any {
    const category = byId.get(categoryId);
    if (!category) {
      throw new NotFoundException(`Category #${categoryId} not found`);
    }

    const tree: any = {
      id: category.id,
      name: category.name,
      children: [],
    };

    // Guard against a malformed parent/child cycle in the data causing
    // unbounded recursion (would otherwise hang or crash the request).
    if (visiting.has(categoryId)) {
      return tree;
    }
    const path = new Set(visiting).add(categoryId);

    if (category.parentId != null) {
      tree.parent = this.buildCategoryTree(
        category.parentId,
        byId,
        childrenByParentId,
        path,
      );
    }

    const children = childrenByParentId.get(categoryId) ?? [];
    if (children.length > 0) {
      tree.children = children.map((child) =>
        this.buildCategoryTree(child.id, byId, childrenByParentId, path),
      );
    }

    return tree;
  }

  async processProductBatch(
    productIds: number[],
  ): Promise<{ success: boolean; processed: number }> {
    let processed = 0;

    try {
      for (const id of productIds) {
        try {
          const product = await this.findOne(id);
          product.updatedAt = new Date();
          await this.productsRepository.save(product);
          processed++;
        } catch (error) {
          console.error(`Error processing product #${id}:`, error);
        }
      }
    } catch (error) {
      throw new BadRequestException('Batch processing failed');
    }

    return { success: true, processed };
  }
}
