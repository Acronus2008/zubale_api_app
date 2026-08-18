import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';

describe('OrdersService', () => {
  let service: OrdersService;
  let ordersRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let usersService: { findOne: jest.Mock };
  let productsService: { updateStock: jest.Mock; findOne: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  };
  let dataSource: { createQueryRunner: jest.Mock };

  beforeEach(async () => {
    queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        create: jest.fn(
          (_entity: unknown, data: Record<string, unknown>) => data,
        ),
        save: jest.fn((_entity: unknown, data: Record<string, unknown>) =>
          Promise.resolve({ id: 1, ...data }),
        ),
        findOne: jest.fn(),
      },
    };
    dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };

    ordersRepository = { find: jest.fn(), findOne: jest.fn(), save: jest.fn() };
    usersService = { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
    productsService = { updateStock: jest.fn(), findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getRepositoryToken(Order), useValue: ordersRepository },
        {
          provide: getRepositoryToken(OrderItem),
          useValue: { create: jest.fn(), save: jest.fn() },
        },
        { provide: UsersService, useValue: usersService },
        { provide: ProductsService, useValue: productsService },
        {
          provide: CACHE_MANAGER,
          useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
        },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();

    service = module.get(OrdersService);
  });

  describe('create — atomicity across items', () => {
    // Bug: the original create() had no transaction, so if item #2 failed
    // its stock check, item #1 (and its already-applied stock decrement)
    // stayed committed — a half-created order.
    it('rolls back the whole order when a later item has insufficient stock', async () => {
      queryRunner.manager.findOne.mockResolvedValue({
        id: 10,
        price: 5,
        name: 'Widget',
      });
      productsService.updateStock
        .mockResolvedValueOnce(undefined) // item 1 succeeds
        .mockRejectedValueOnce(
          new BadRequestException('Not enough stock for Widget'),
        ); // item 2 fails

      const dto: CreateOrderDto = {
        userId: 1,
        items: [
          { productId: 10, quantity: 1 },
          { productId: 10, quantity: 999 },
        ],
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);

      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('commits once, and only once, when every item has enough stock', async () => {
      queryRunner.manager.findOne.mockResolvedValue({
        id: 10,
        price: 5,
        name: 'Widget',
      });
      productsService.updateStock.mockResolvedValue(undefined);
      ordersRepository.findOne.mockResolvedValue({
        id: 1,
        status: OrderStatus.PENDING,
        items: [],
      });

      const dto: CreateOrderDto = {
        userId: 1,
        items: [{ productId: 10, quantity: 2 }],
      };
      await service.create(dto);

      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(productsService.updateStock).toHaveBeenCalledWith(
        10,
        -2,
        queryRunner.manager,
      );
    });
  });

  describe('processPayment — bounded retries', () => {
    // Bug: maxRetries was 1000 with a 100ms delay against a mock service
    // that fails ~10% of the time, so a request could hang retrying for a
    // very long time. It must now give up after a small, bounded number of
    // attempts.
    it('configures a small retry budget instead of the previous 1000', () => {
      expect(service['maxRetries']).toBeGreaterThan(0);
      expect(service['maxRetries']).toBeLessThanOrEqual(5);
    });

    it('gives up and rejects soon after exhausting its retry budget, rather than hanging', async () => {
      ordersRepository.findOne.mockResolvedValue({
        id: 1,
        total: 100,
        status: OrderStatus.PENDING,
      });
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0); // forces the mock payment service to fail every attempt

      const start = Date.now();
      await expect(service.processPayment(1)).rejects.toThrow(
        'Payment service unavailable',
      );
      const elapsedMs = Date.now() - start;

      // 3 retries * (~100ms mock latency + ~100ms backoff) ~= 600ms. With
      // the old maxRetries = 1000 this same assertion would take minutes.
      expect(elapsedMs).toBeLessThan(5000);

      randomSpy.mockRestore();
    }, 10000);
  });

  describe('getOrderWithFullDetails — no circular structure', () => {
    // Bug: enriched.user.latestOrder was assigned `enriched` itself,
    // creating a real cycle that made JSON.stringify throw
    // "Converting circular structure to JSON" — a vague 500 to the client.
    it('returns a JSON-safe payload without throwing', async () => {
      ordersRepository.findOne.mockResolvedValue({
        id: 5,
        status: OrderStatus.CONFIRMED,
        total: 42,
        user: { id: 1, name: 'Ada', email: 'ada@example.com' },
        items: [],
      });

      const result = (await service.getOrderWithFullDetails(5)) as {
        user: {
          latestOrder: { id: number; status: OrderStatus; total: number };
        };
      };

      expect(result.user.latestOrder).toEqual({
        id: 5,
        status: OrderStatus.CONFIRMED,
        total: 42,
      });
      expect(() => JSON.stringify(result)).not.toThrow();
    });
  });
});
