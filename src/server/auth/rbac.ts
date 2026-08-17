/**
 * Role-based access control.
 *
 * Permissions are a flat, explicit list rather than a role hierarchy with
 * inheritance. Inheritance reads well right up until someone adds a permission to
 * a base role and silently grants it to everyone above — a table you can read top
 * to bottom is easier to audit than a graph you have to traverse.
 *
 * The default is always deny: an unknown role or an unknown permission gets
 * nothing.
 */

export type Role = 'owner' | 'admin' | 'planner' | 'operator' | 'viewer';

export type Permission =
  | 'inventory:read'
  | 'inventory:move'
  | 'inventory:adjust'
  | 'catalogue:read'
  | 'catalogue:write'
  | 'decision:read'
  | 'decision:approve'
  | 'purchase_order:read'
  | 'purchase_order:write'
  | 'agent:run'
  | 'agent:configure'
  | 'audit:read'
  | 'user:manage'
  | 'api_key:manage'
  | 'org:manage';

const READ_ONLY: readonly Permission[] = [
  'inventory:read',
  'catalogue:read',
  'decision:read',
  'purchase_order:read',
];

/**
 * The permission matrix.
 *
 * Notable boundaries:
 *  - **operator** can move stock but cannot adjust it. Booking a receipt is
 *    routine; writing off a discrepancy is how shrinkage gets hidden, so it needs
 *    a planner.
 *  - **planner** can approve the agent's decisions but cannot change the agent's
 *    limits. Whoever sets the spending cap should not also be the one approving
 *    spends against it.
 *  - **admin** can configure the agent but cannot transfer ownership.
 */
const MATRIX: Record<Role, readonly Permission[]> = {
  viewer: READ_ONLY,

  operator: [...READ_ONLY, 'inventory:move'],

  planner: [
    ...READ_ONLY,
    'inventory:move',
    'inventory:adjust',
    'catalogue:write',
    'decision:approve',
    'purchase_order:write',
    'agent:run',
  ],

  admin: [
    ...READ_ONLY,
    'inventory:move',
    'inventory:adjust',
    'catalogue:write',
    'decision:approve',
    'purchase_order:write',
    'agent:run',
    'agent:configure',
    'audit:read',
    'user:manage',
    'api_key:manage',
  ],

  owner: [
    ...READ_ONLY,
    'inventory:move',
    'inventory:adjust',
    'catalogue:write',
    'decision:approve',
    'purchase_order:write',
    'agent:run',
    'agent:configure',
    'audit:read',
    'user:manage',
    'api_key:manage',
    'org:manage',
  ],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return MATRIX[role] ?? [];
}

export function can(role: Role, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

export class ForbiddenError extends Error {
  readonly permission: Permission;
  readonly role: Role;

  constructor(role: Role, permission: Permission) {
    super(`Role ${role} lacks permission ${permission}`);
    this.name = 'ForbiddenError';
    this.role = role;
    this.permission = permission;
  }
}

/** Throw unless the role holds the permission. */
export function requirePermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(role, permission);
}

/**
 * Whether `actor` may change `target`'s role.
 *
 * Two rules, both aimed at the same failure: an admin quietly escalating
 * themselves. Nobody may grant a role at or above their own, and nobody may
 * change their own role at all.
 */
export function canAssignRole(actorRole: Role, actorId: string, targetId: string, newRole: Role): boolean {
  if (!can(actorRole, 'user:manage')) return false;
  if (actorId === targetId) return false;

  const rank: Record<Role, number> = { viewer: 0, operator: 1, planner: 2, admin: 3, owner: 4 };
  return rank[newRole] < rank[actorRole];
}
