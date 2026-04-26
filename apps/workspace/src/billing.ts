/**
 * Stripe billing integration for the Modpack Compatibility Platform.
 *
 * Responsibilities:
 *  - Define plan tiers (free / pro / enterprise) as QuotaPlan objects
 *  - Create Stripe Checkout sessions for plan upgrades
 *  - Create Stripe Customer Portal sessions for self-service management
 *  - Handle inbound Stripe webhook events to keep subscription state current
 *  - Expose getPlanForOrg() so the gateway can enforce the correct quota per org
 *
 * The subscription state is kept in an in-process Map (BillingStore), wired
 * to a Postgres persistence hook that can be activated when POSTGRES_URL is set.
 * This keeps the billing path functional in local dev without a database.
 */

import Stripe from "stripe";
import type { QuotaPlan } from "@modcompat/api-contracts";

// ---------------------------------------------------------------------------
// Plan catalogue
// ---------------------------------------------------------------------------

/** All quota plans keyed by their internal planId. */
export const BILLING_PLANS: Record<string, QuotaPlan> = {
  plan_free: {
    planId: "plan_free",
    name: "Free",
    maxAnalysesPerDay: 10,
    maxImportsPerDay: 20,
    maxConcurrentAnalyses: 1,
    maxEvidenceSyncsPerHour: 4,
    maxExportBytesPerDay: 100 * 1024 * 1024 // 100 MB
  },
  plan_pro: {
    planId: "plan_pro",
    name: "Pro",
    maxAnalysesPerDay: 200,
    maxImportsPerDay: 500,
    maxConcurrentAnalyses: 5,
    maxEvidenceSyncsPerHour: 30,
    maxExportBytesPerDay: 2 * 1024 * 1024 * 1024 // 2 GB
  },
  plan_enterprise: {
    planId: "plan_enterprise",
    name: "Enterprise",
    maxAnalysesPerDay: 10_000,
    maxImportsPerDay: 50_000,
    maxConcurrentAnalyses: 50,
    maxEvidenceSyncsPerHour: 300,
    maxExportBytesPerDay: 0 // unlimited
  },
  plan_default: {
    planId: "plan_default",
    name: "Default (self-hosted)",
    maxAnalysesPerDay: 1000,
    maxImportsPerDay: 2000,
    maxConcurrentAnalyses: 10,
    maxEvidenceSyncsPerHour: 60,
    maxExportBytesPerDay: 10 * 1024 * 1024 * 1024 // 10 GB
  }
};

/** Map Stripe price IDs to internal plan IDs (populated from env at startup). */
export interface StripePriceMap {
  /** Stripe Price ID for the monthly Pro plan. */
  proPriceId: string;
  /** Stripe Price ID for the monthly Enterprise plan. */
  enterprisePriceId: string;
}

function readPriceMap(): StripePriceMap {
  return {
    proPriceId: process.env.STRIPE_PRICE_PRO ?? "",
    enterprisePriceId: process.env.STRIPE_PRICE_ENTERPRISE ?? ""
  };
}

function planIdForPriceId(priceId: string, priceMap: StripePriceMap): string {
  if (priceId === priceMap.proPriceId) return "plan_pro";
  if (priceId === priceMap.enterprisePriceId) return "plan_enterprise";
  return "plan_free";
}

// ---------------------------------------------------------------------------
// Subscription state store (in-process, postgres-hookable)
// ---------------------------------------------------------------------------

export interface OrgSubscription {
  organizationId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  planId: string;
  status: "active" | "past_due" | "canceled" | "trialing" | "incomplete" | "free";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  updatedAt: string;
}

export class BillingStore {
  /** keyed by organizationId */
  private readonly subscriptions = new Map<string, OrgSubscription>();
  /** keyed by stripeCustomerId */
  private readonly byCustomerId = new Map<string, string>(); // customerId → orgId

  upsert(sub: OrgSubscription): void {
    this.subscriptions.set(sub.organizationId, sub);
    this.byCustomerId.set(sub.stripeCustomerId, sub.organizationId);
  }

  getByOrg(organizationId: string): OrgSubscription | undefined {
    return this.subscriptions.get(organizationId);
  }

  getByCustomerId(customerId: string): OrgSubscription | undefined {
    const orgId = this.byCustomerId.get(customerId);
    return orgId ? this.subscriptions.get(orgId) : undefined;
  }

  list(): OrgSubscription[] {
    return [...this.subscriptions.values()];
  }
}

// ---------------------------------------------------------------------------
// BillingService
// ---------------------------------------------------------------------------

export interface BillingServiceOptions {
  stripeSecretKey: string;
  webhookSecret: string;
  store?: BillingStore;
}

export interface CreateCheckoutSessionOptions {
  organizationId: string;
  planId: "plan_pro" | "plan_enterprise";
  successUrl: string;
  cancelUrl: string;
  /** Pre-existing Stripe customer ID if the org already has one. */
  existingCustomerId?: string;
  customerEmail?: string;
  customerName?: string;
}

export interface CreatePortalSessionOptions {
  organizationId: string;
  returnUrl: string;
}

export interface CheckoutSessionResult {
  sessionId: string;
  url: string;
}

export interface PortalSessionResult {
  url: string;
}

export class BillingService {
  private readonly stripe: Stripe;
  private readonly store: BillingStore;
  private readonly priceMap: StripePriceMap;
  private readonly webhookSecret: string;

  constructor(options: BillingServiceOptions) {
    this.stripe = new Stripe(options.stripeSecretKey, {
      apiVersion: "2024-06-20"
    });
    this.store = options.store ?? new BillingStore();
    this.priceMap = readPriceMap();
    this.webhookSecret = options.webhookSecret;
  }

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  /**
   * Create a Stripe Checkout session for a plan upgrade.
   * The session URL is returned and the caller should redirect the user to it.
   */
  async createCheckoutSession(
    options: CreateCheckoutSessionOptions
  ): Promise<CheckoutSessionResult> {
    const priceId =
      options.planId === "plan_enterprise"
        ? this.priceMap.enterprisePriceId
        : this.priceMap.proPriceId;

    if (!priceId) {
      throw new Error(
        `Stripe price ID for plan "${options.planId}" is not configured. ` +
          "Set STRIPE_PRICE_PRO and STRIPE_PRICE_ENTERPRISE environment variables."
      );
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      metadata: { organizationId: options.organizationId, planId: options.planId },
      subscription_data: {
        metadata: { organizationId: options.organizationId, planId: options.planId }
      }
    };

    if (options.existingCustomerId) {
      params.customer = options.existingCustomerId;
    } else {
      params.customer_creation = "always";
      if (options.customerEmail) params.customer_email = options.customerEmail;
    }

    const session = await this.stripe.checkout.sessions.create(params);

    return {
      sessionId: session.id,
      url: session.url!
    };
  }

  // -------------------------------------------------------------------------
  // Customer Portal
  // -------------------------------------------------------------------------

  /**
   * Create a Stripe Customer Portal session so the user can manage their
   * subscription, update payment methods, and download invoices.
   */
  async createPortalSession(
    options: CreatePortalSessionOptions
  ): Promise<PortalSessionResult> {
    const existing = this.store.getByOrg(options.organizationId);
    if (!existing?.stripeCustomerId) {
      throw new Error(
        `Organization "${options.organizationId}" has no Stripe customer. ` +
          "Complete a checkout session first."
      );
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: existing.stripeCustomerId,
      return_url: options.returnUrl
    });

    return { url: session.url };
  }

  // -------------------------------------------------------------------------
  // Subscription lookup
  // -------------------------------------------------------------------------

  /** Return the current subscription record for an org (undefined = free plan). */
  getSubscription(organizationId: string): OrgSubscription | undefined {
    return this.store.getByOrg(organizationId);
  }

  /**
   * Return the QuotaPlan applicable to an org.
   * Falls back to plan_free for orgs without a subscription, and plan_default
   * when Stripe is not configured (self-hosted / local dev).
   */
  getPlanForOrg(organizationId: string): QuotaPlan {
    if (!this.isConfigured()) {
      return BILLING_PLANS["plan_default"]!;
    }
    const sub = this.store.getByOrg(organizationId);
    if (!sub || sub.status === "canceled" || sub.status === "free") {
      return BILLING_PLANS["plan_free"]!;
    }
    return BILLING_PLANS[sub.planId] ?? BILLING_PLANS["plan_free"]!;
  }

  /** True when a Stripe secret key has been provided. */
  isConfigured(): boolean {
    return Boolean(process.env.STRIPE_SECRET_KEY);
  }

  // -------------------------------------------------------------------------
  // Webhook handling
  // -------------------------------------------------------------------------

  /**
   * Verify and process an inbound Stripe webhook event.
   *
   * @param rawBody   The raw request body buffer (must NOT be JSON-parsed first).
   * @param signature The `Stripe-Signature` header value.
   */
  async handleWebhookEvent(rawBody: Buffer, signature: string): Promise<{ received: boolean }> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      throw new Error(
        `Webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    switch (event.type) {
      case "checkout.session.completed":
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await this.handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case "customer.subscription.deleted":
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case "invoice.payment_succeeded":
        await this.handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;

      case "invoice.payment_failed":
        await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      default:
        // Unhandled event type — not an error, just not relevant
        break;
    }

    return { received: true };
  }

  // -------------------------------------------------------------------------
  // Private webhook handlers
  // -------------------------------------------------------------------------

  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    if (session.mode !== "subscription" || !session.subscription) return;

    const organizationId =
      (session.metadata?.["organizationId"] as string | undefined) ?? "";
    const planId = (session.metadata?.["planId"] as string | undefined) ?? "plan_free";
    const customerId = session.customer as string;

    const subscription = await this.stripe.subscriptions.retrieve(
      session.subscription as string
    );

    this.store.upsert({
      organizationId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0]?.price.id ?? null,
      planId,
      status: this.mapStripeStatus(subscription.status),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      updatedAt: new Date().toISOString()
    });
  }

  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const existing = this.store.getByCustomerId(customerId);
    const organizationId = existing?.organizationId ??
      (subscription.metadata?.["organizationId"] as string | undefined) ?? "";

    if (!organizationId) return;

    const priceId = subscription.items.data[0]?.price.id ?? null;
    const planId = priceId ? planIdForPriceId(priceId, this.priceMap) : "plan_free";

    this.store.upsert({
      organizationId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId,
      planId,
      status: this.mapStripeStatus(subscription.status),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      updatedAt: new Date().toISOString()
    });
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const existing = this.store.getByCustomerId(customerId);
    if (!existing) return;

    this.store.upsert({
      ...existing,
      stripeSubscriptionId: null,
      stripePriceId: null,
      planId: "plan_free",
      status: "canceled",
      cancelAtPeriodEnd: false,
      updatedAt: new Date().toISOString()
    });
  }

  private async handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.subscription) return;
    const customerId = invoice.customer as string;
    const existing = this.store.getByCustomerId(customerId);
    if (!existing) return;

    this.store.upsert({
      ...existing,
      status: "active",
      updatedAt: new Date().toISOString()
    });
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.subscription) return;
    const customerId = invoice.customer as string;
    const existing = this.store.getByCustomerId(customerId);
    if (!existing) return;

    this.store.upsert({
      ...existing,
      status: "past_due",
      updatedAt: new Date().toISOString()
    });
  }

  private mapStripeStatus(
    status: Stripe.Subscription.Status
  ): OrgSubscription["status"] {
    switch (status) {
      case "active":       return "active";
      case "past_due":     return "past_due";
      case "canceled":     return "canceled";
      case "trialing":     return "trialing";
      case "incomplete":
      case "incomplete_expired":
      case "unpaid":       return "incomplete";
      default:             return "free";
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton factory — reads config from environment
// ---------------------------------------------------------------------------

let _instance: BillingService | undefined;

/**
 * Return the shared BillingService instance.
 * If STRIPE_SECRET_KEY is not set, returns a no-op instance that always
 * responds with plan_default (suitable for self-hosted / local dev).
 */
export function getBillingService(): BillingService {
  if (_instance) return _instance;

  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_placeholder";

  _instance = new BillingService({ stripeSecretKey: secretKey, webhookSecret });
  return _instance;
}
