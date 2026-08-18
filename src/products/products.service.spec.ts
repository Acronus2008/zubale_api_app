import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto } from './dto/create-product.dto';

interface CategoryTreeNode {
  id: number;
  name: string;
  parent?: CategoryTreeNode;
  children: CategoryTreeNode[];
}

describe('ProductsService', () => {
  let service: ProductsService;
  let productsRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    increment: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let categoriesRepository: { find: jest.Mock };
  let cacheManager: {
    get: jest.Mock<Promise<unknown>, [string]>;
    set: jest.Mock<Promise<void>, [string, unknown, number?]>;
    del: jest.Mock<Promise<void>, [string]>;
  };

  let queryBuilderExecute: jest.Mock;

  beforeEach(async () => {
    queryBuilderExecute = jest.fn();
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: queryBuilderExecute,
    };

    productsRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      increment: jest.fn(),
      create: jest.fn((dto: CreateProductDto) => dto),
      save: jest.fn((entity: unknown) =>
        Promise.resolve({ id: 1, ...(entity as object) }),
      ),
    };
    categoriesRepository = { find: jest.fn() };
    cacheManager = {
      get: jest.fn<Promise<unknown>, [string]>(),
      set: jest.fn<Promise<void>, [string, unknown, number?]>(),
      del: jest.fn<Promise<void>, [string]>(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: productsRepository },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        { provide: CACHE_MANAGER, useValue: cacheManager },
      ],
    }).compile();

    service = module.get(ProductsService);
  });

  describe('searchProducts — cache key must be query-specific', () => {
    // Bug: the old implementation used the single hardcoded key
    // 'product-search' for every query, so a search for "phone" would
    // return cached "shoes" results. Two different queries must use two
    // different cache keys.
    it('uses a distinct cache entry per query instead of one shared key', async () => {
      cacheManager.get.mockResolvedValue(null);
      productsRepository.find.mockResolvedValue([
        { name: 'Phone', description: '' } as Product,
        { name: 'Shoes', description: '' } as Product,
      ]);

      await service.searchProducts('phone');
      await service.searchProducts('shoes');

      const getKeys = cacheManager.get.mock.calls.map((call) => call[0]);
      const setKeys = cacheManager.set.mock.calls.map((call) => call[0]);

      expect(new Set(getKeys).size).toBe(2);
      expect(new Set(setKeys).size).toBe(2);
      expect(getKeys).not.toContain('product-search');
    });

    it('invalidates previously cached searches when a product is created', async () => {
      cacheManager.get.mockResolvedValue(null);
      productsRepository.find.mockResolvedValue([]);
      await service.searchProducts('phone');

      await service.create({ name: 'New', price: 1 } as CreateProductDto);

      expect(cacheManager.del).toHaveBeenCalledWith(
        service['searchCacheKey']('phone'),
      );
    });
  });

  describe('updateStock — atomic stock updates', () => {
    it('decrements stock with a single conditional UPDATE and succeeds when stock is sufficient', async () => {
      queryBuilderExecute.mockResolvedValue({ affected: 1 });

      await expect(service.updateStock(1, -3)).resolves.toBeUndefined();
      expect(productsRepository.createQueryBuilder).toHaveBeenCalled();
    });

    it('throws instead of allowing stock to go negative when the conditional UPDATE affects no rows', async () => {
      queryBuilderExecute.mockResolvedValue({ affected: 0 });
      productsRepository.findOne.mockResolvedValue({
        id: 1,
        name: 'Widget',
        stock: 2,
      } as Product);

      await expect(service.updateStock(1, -5)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('restores stock via increment for positive deltas (e.g. order cancellation)', async () => {
      await service.updateStock(1, 4);
      expect(productsRepository.increment).toHaveBeenCalledWith(
        { id: 1 },
        'stock',
        4,
      );
    });
  });

  describe('getCategoryTree — deep hierarchies', () => {
    // Bug: findCategory() only eager-loads `parent`/`children` one level
    // deep, so recursing into category.parent/category.children for a tree
    // deeper than 1 level either threw (parent direction) or silently
    // truncated (children direction).
    it('builds a full parent chain and children list at 3+ levels without throwing', async () => {
      const root = { id: 1, name: 'Root', parentId: null } as Category;
      const mid = { id: 2, name: 'Mid', parentId: 1 } as Category;
      const leaf = { id: 3, name: 'Leaf', parentId: 2 } as Category;
      categoriesRepository.find.mockResolvedValue([root, mid, leaf]);

      const tree = (await service.getCategoryTree(3)) as CategoryTreeNode;

      expect(tree.id).toBe(3);
      expect(tree.parent?.id).toBe(2);
      expect(tree.parent?.parent?.id).toBe(1);
      expect(tree.parent?.parent?.parent).toBeUndefined();

      const rootTree = (await service.getCategoryTree(1)) as CategoryTreeNode;
      expect(rootTree.children).toHaveLength(1);
      expect(rootTree.children[0].id).toBe(2);
      expect(rootTree.children[0].children[0].id).toBe(3);
    });

    it('does not recurse infinitely if category data contains a cycle', async () => {
      const a = { id: 1, name: 'A', parentId: 2 } as Category;
      const b = { id: 2, name: 'B', parentId: 1 } as Category;
      categoriesRepository.find.mockResolvedValue([a, b]);

      await expect(service.getCategoryTree(1)).resolves.toBeDefined();
    });
  });
});
