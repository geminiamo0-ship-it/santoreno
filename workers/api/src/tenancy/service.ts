import type {
  CreateTenantRequest,
  PortalContextResponse,
  Tenant,
  UpdateTenantRequest,
} from "@santo/contracts";

import type { PortalIdentity } from "../auth/workos";
import type { SantoBindings } from "../runtime/bindings";
import type { TenantRepository } from "./repository";

interface SuperAdminPrincipal {
  userId: string;
  role: "super_admin";
  tenant: null;
}

interface OwnerPrincipal {
  userId: string;
  role: "owner";
  tenant: Tenant;
}

type PortalPrincipal = SuperAdminPrincipal | OwnerPrincipal;

export class TenancyError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 503,
    readonly code:
      | "FORBIDDEN"
      | "TENANT_CONTEXT_REQUIRED"
      | "TENANT_NOT_FOUND"
      | "TENANT_INACTIVE"
      | "TENANT_CONFLICT"
      | "TENANCY_NOT_CONFIGURED",
    message: string,
  ) {
    super(message);
    this.name = "TenancyError";
  }
}

function superAdminIds(env: SantoBindings): Set<string> {
  return new Set(
    (env.SANTO_SUPER_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export class TenantControlService {
  constructor(
    private readonly repository: TenantRepository,
    private readonly env: SantoBindings,
  ) {}

  private async resolvePrincipal(identity: PortalIdentity): Promise<PortalPrincipal> {
    if (superAdminIds(this.env).has(identity.userId)) {
      return {
        userId: identity.userId,
        role: "super_admin",
        tenant: null,
      };
    }

    if (!identity.organizationId) {
      throw new TenancyError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "A WorkOS organization is required for tenant access",
      );
    }

    const tenant = await this.repository.findTenantByWorkOSOrgId(identity.organizationId);
    if (!tenant) {
      throw new TenancyError(403, "FORBIDDEN", "WorkOS organization is not mapped to Santo");
    }

    if (tenant.status !== "active") {
      throw new TenancyError(403, "TENANT_INACTIVE", "Tenant is not active");
    }

    const membership = await this.repository.findMembership(tenant.id, identity.userId);
    if (!membership || membership.role !== "owner") {
      throw new TenancyError(403, "FORBIDDEN", "User is not an owner of this tenant");
    }

    return {
      userId: identity.userId,
      role: "owner",
      tenant,
    };
  }

  async getPortalContext(identity: PortalIdentity): Promise<PortalContextResponse> {
    const principal = await this.resolvePrincipal(identity);
    return {
      userId: principal.userId,
      role: principal.role,
      tenant: principal.tenant,
    };
  }

  async createTenant(identity: PortalIdentity, input: CreateTenantRequest): Promise<Tenant> {
    const principal = await this.resolvePrincipal(identity);
    if (principal.role !== "super_admin") {
      throw new TenancyError(403, "FORBIDDEN", "Super Admin access is required");
    }

    const existingOrganization = await this.repository.findTenantByWorkOSOrgId(input.workosOrgId);
    if (existingOrganization) {
      throw new TenancyError(409, "TENANT_CONFLICT", "WorkOS organization is already mapped");
    }

    return this.repository.createTenantWithOwner(input);
  }

  async getTenant(identity: PortalIdentity, requestedTenantId: string): Promise<Tenant> {
    const principal = await this.resolvePrincipal(identity);
    if (principal.role !== "owner" || principal.tenant.id !== requestedTenantId) {
      throw new TenancyError(403, "FORBIDDEN", "Cross-tenant access is forbidden");
    }

    const tenant = await this.repository.findTenantById(principal.tenant.id);
    if (!tenant) {
      throw new TenancyError(404, "TENANT_NOT_FOUND", "Tenant no longer exists");
    }

    return tenant;
  }

  async updateTenant(
    identity: PortalIdentity,
    requestedTenantId: string,
    input: UpdateTenantRequest,
  ): Promise<Tenant> {
    const principal = await this.resolvePrincipal(identity);
    if (principal.role !== "owner" || principal.tenant.id !== requestedTenantId) {
      throw new TenancyError(403, "FORBIDDEN", "Cross-tenant mutation is forbidden");
    }

    const tenant = await this.repository.updateTenantName(principal.tenant.id, input.name);
    if (!tenant) {
      throw new TenancyError(404, "TENANT_NOT_FOUND", "Tenant no longer exists");
    }

    return tenant;
  }
}
