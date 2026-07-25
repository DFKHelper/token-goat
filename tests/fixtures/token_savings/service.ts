// Synthetic fixture for the token-savings regression benchmark.
// Deliberately padded with several unrelated exports so the full file is much
// larger than any single symbol a surgical read would return.

export interface UserRecord {
  id: string
  name: string
  email: string
  createdAt: number
  roles: string[]
}

export interface OrderRecord {
  id: string
  userId: string
  total: number
  items: string[]
  status: 'pending' | 'shipped' | 'cancelled'
}

const USERS = new Map<string, UserRecord>()
const ORDERS = new Map<string, OrderRecord>()

export function registerUser(record: UserRecord): void {
  if (USERS.has(record.id)) {
    throw new Error(`user already registered: ${record.id}`)
  }
  USERS.set(record.id, record)
}

export function deregisterUser(id: string): boolean {
  return USERS.delete(id)
}

export function listUsers(): UserRecord[] {
  return Array.from(USERS.values())
}

export function registerOrder(record: OrderRecord): void {
  if (!USERS.has(record.userId)) {
    throw new Error(`unknown user for order: ${record.userId}`)
  }
  ORDERS.set(record.id, record)
}

export function listOrdersForUser(userId: string): OrderRecord[] {
  return Array.from(ORDERS.values()).filter((order) => order.userId === userId)
}

export function cancelOrder(id: string): boolean {
  const order = ORDERS.get(id)
  if (order === undefined) return false
  order.status = 'cancelled'
  return true
}

export class UserService {
  private readonly cache = new Map<string, UserRecord>()

  constructor(private readonly ttlMs: number = 60_000) {}

  /**
   * Look up a single user by id, checking the local cache before falling
   * back to the in-memory store. This is the target symbol for the
   * token-savings benchmark's `symbol`/`read` measurements -- it is a
   * small, self-contained method inside a much larger file.
   */
  fetchUser(id: string): UserRecord | undefined {
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached
    const user = USERS.get(id)
    if (user !== undefined) this.cache.set(id, user)
    return user
  }

  fetchUsersByRole(role: string): UserRecord[] {
    return listUsers().filter((user) => user.roles.includes(role))
  }

  invalidate(id: string): void {
    this.cache.delete(id)
  }

  clearCache(): void {
    this.cache.clear()
  }
}

export class OrderService {
  totalForUser(userId: string): number {
    return listOrdersForUser(userId).reduce((sum, order) => sum + order.total, 0)
  }

  pendingOrders(): OrderRecord[] {
    return Array.from(ORDERS.values()).filter((order) => order.status === 'pending')
  }

  shipOrder(id: string): boolean {
    const order = ORDERS.get(id)
    if (order === undefined) return false
    order.status = 'shipped'
    return true
  }
}

export function summarizeUser(id: string): string {
  const user = USERS.get(id)
  if (user === undefined) return `no such user: ${id}`
  const orders = listOrdersForUser(id)
  const total = orders.reduce((sum, order) => sum + order.total, 0)
  return `${user.name} <${user.email}>: ${orders.length} orders, $${total.toFixed(2)} total`
}

export function purgeExpiredOrders(now: number, maxAgeMs: number): number {
  let purged = 0
  for (const [id, order] of ORDERS) {
    if (order.status === 'cancelled' && now - maxAgeMs > 0) {
      ORDERS.delete(id)
      purged += 1
    }
  }
  return purged
}
