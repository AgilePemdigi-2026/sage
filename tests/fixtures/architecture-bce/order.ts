export class OrderEntity {
  id: string = "order-1";
  total: number = 0;
  updateTotal(value: number): void { this.total = value; }
}
export class OrderService {
  create(order: OrderEntity): OrderEntity { order.updateTotal(100); return order; }
}
export class OrderController {
  readonly service: OrderService = new OrderService();
  submit(order: OrderEntity): OrderEntity { return this.service.create(order); }
}
export class OrderView {
  readonly controller: OrderController = new OrderController();
  save(order: OrderEntity): OrderEntity { return this.controller.submit(order); }
}
export function handleOrder(order: OrderEntity): OrderEntity {
  const controller = new OrderController();
  return controller.submit(order);
}
export class PriorityOrder extends OrderEntity {
  calculate(): number { this.updateTotal(200); return this.total; }
}
