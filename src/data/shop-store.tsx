import { useAction, useConvex, useMutation, useQueries, useQuery, type ConvexReactClient } from 'convex/react';
import { ConvexError } from 'convex/values';
import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { convexConfigured, useSession } from '@/lib/session';

import * as cartApi from './cart-api';
import { api } from './convex-api';
import { mockComparison } from './mock-comparison';
import { mockReviews } from './mock-reviews';
import { isTestUserItem, TEST_USER_ITEM_URL } from './test-user';
import type {
  CartItem,
  DecideOutcome,
  Offer,
  PriceComparison,
  Purchase,
  PurchaseRequest,
  QueryAlternative,
  Quote,
  ReviewList,
} from './types';

/**
 * Screen-facing state. With EXPO_PUBLIC_CONVEX_URL set, lists are live useQuery subscriptions on the
 * deployed backend for the signed-in shopper; without it, the same state comes from the in-memory mocks
 * so the app still runs offline. Screens only see ShopState.
 */

interface PendingQuote {
  requestId: string;
  quoteVersion: number;
  quote: Quote;
}

type Decision = 'approve' | 'defer';
type DecideResult = { outcome: DecideOutcome; request: PurchaseRequest };

interface ShopState {
  live: boolean;
  ready: boolean;
  error: string | null;
  items: CartItem[];
  purchases: Purchase[];
  purchasedItems: Record<string, CartItem>;
  cartCount: number;
  /** Adds a product URL and returns the new item's id; enrichment fills it in afterwards. */
  addItem: (url: string) => Promise<string>;
  /** Resolves free text to a product and adds it; throws a short message when nothing matched. */
  addItemFromQuery: (query: string) => Promise<{ itemId: string; alternatives: QueryAlternative[] }>;
  setQuantity: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  loadDemoCart: () => Promise<void>;
  prepareTestCart: (pending: boolean) => void;
  /** Quotes the item and approves that quote in one step; throws a short message when no order was placed. */
  checkoutItem: (item: CartItem) => Promise<void>;
}

const ShopContext = createContext<ShopState | null>(null);

let keyCounter = 0;
export const idempotencyKey = () => `app-${Date.now()}-${keyCounter++}`;

export function errorMessage(error: unknown) {
  if (error instanceof ConvexError && typeof error.data?.message === 'string') return error.data.message as string;
  if (error instanceof Error && !error.message.includes('[Request ID')) return error.message;
  return 'Something went wrong. Try again.';
}

function toPending(result: Pick<PurchaseRequest, 'requestId' | 'status' | 'quoteVersion' | 'quote'>): PendingQuote {
  if (result.status !== 'pending_approval' || !result.quote) throw new Error('This item could not be quoted right now.');
  return { requestId: result.requestId, quoteVersion: result.quoteVersion, quote: result.quote };
}

const purchaseArgs = (item: CartItem) => {
  const offer = itemOffer(item);
  if (!offer) throw new Error(item.offerAvailability?.note ?? 'This item has no price yet.');
  return {
    itemId: item.id,
    offerId: offer.id,
    quantity: item.quantity,
    reason: 'Bought from the Cart app',
    idempotencyKey: idempotencyKey(),
  };
};

const outcomeMessages: Partial<Record<DecideOutcome, string>> = {
  stale_quote: 'The price changed again. Try again.',
  expired: 'That quote expired. Try again.',
  invalid_state: "This item can't be bought right now.",
};

/** requestPurchase, then decidePurchase approve, re-approving once if the quote moved in between. */
async function placeOrder(
  item: CartItem,
  quoteItem: (item: CartItem) => Promise<PendingQuote>,
  decide: (request: PendingQuote, decision: Decision) => Promise<DecideResult>
) {
  const first = await decide(await quoteItem(item), 'approve');
  const { requestId, quoteVersion, quote } = first.request;
  const { outcome, request } =
    first.outcome === 'stale_quote' && quote ? await decide({ requestId, quoteVersion, quote }, 'approve') : first;
  if (outcome !== 'approved' && outcome !== 'already_approved') {
    throw new Error(outcomeMessages[outcome] ?? 'The order was not placed. Try again.');
  }
  if (request.status === 'failed' || request.order?.status === 'failed') throw new Error(request.error ?? 'The order failed. Try again.');
  return request;
}

/**
 * Approval only schedules the order; the retailer places it afterwards. Resolves once the order is placed and
 * rejects when it fails or needs a new quote, so the card keeps its busy state until the real outcome.
 */
function placementOf(convex: ConvexReactClient, requestId: string) {
  return new Promise<void>((resolve, reject) => {
    const watch = convex.watchQuery(api.purchases.getPurchaseStatus, { requestId });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      let request: PurchaseRequest | undefined;
      try {
        request = watch.localQueryResult();
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (!request) return;
      const order = request.order?.status;
      if (request.status === 'ordered' || order === 'placed') finish();
      else if (request.status === 'failed' || order === 'failed') finish(new Error(request.error ?? 'The order failed. Try again.'));
      else if (order === 'requote_required') finish(new Error('The price changed. Try again.'));
    };
    const timer = setTimeout(() => finish(new Error('Still placing this order. Check Purchases before trying again.')), 180_000);
    const unsubscribe = watch.onUpdate(check);
    check();
  });
}

const countOf = (items: CartItem[]) => items.reduce((sum, item) => sum + item.quantity, 0);

function LiveShopProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const signedIn = session === 'signed_in';
  const convex = useConvex();

  const items = useQuery(api.cart.listItems, signedIn ? {} : 'skip');
  const purchases = useQuery(api.purchases.listPurchases, signedIn ? {} : 'skip');
  const details = useQueries(
    Object.fromEntries(
      (purchases ?? []).map((p) => [p.itemId, { query: api.cart.getItem, args: { itemId: p.itemId } }])
    )
  );
  const purchasedItems: Record<string, CartItem> = {};
  for (const [itemId, detail] of Object.entries(details)) {
    if (detail && !(detail instanceof Error)) purchasedItems[itemId] = detail as CartItem;
  }

  const addItem = useMutation(api.cart.addItem);
  const setQuantity = useMutation(api.cart.setQuantity);
  const removeItem = useMutation(api.cart.removeItem);
  const setupMyCart = useMutation(api.demo.setupMyCart);
  const requestPurchase = useAction(api.purchases.requestPurchase);
  const decidePurchase = useMutation(api.purchases.decidePurchase);
  const [testCartPending, prepareTestCart] = useState(false);
  const [testCartError, setTestCartError] = useState<string | null>(null);
  const testCartInFlight = useRef(false);

  useEffect(() => {
    if (!testCartPending || !signedIn || testCartInFlight.current) return;
    testCartInFlight.current = true;
    const ensureItem = async () => {
      const currentItems = await convex.query(api.cart.listItems, {});
      if (currentItems.some((item) => isTestUserItem(item.url))) return;
      await addItem({ url: TEST_USER_ITEM_URL, idempotencyKey: idempotencyKey() });
    };
    ensureItem()
      .then(() => setTestCartError(null))
      .catch(() => setTestCartError("Couldn't add the demo item. Sign out and try again."))
      .finally(() => {
        testCartInFlight.current = false;
        prepareTestCart(false);
      });
  }, [testCartPending, signedIn, convex, addItem]);

  const value: ShopState = {
    live: true,
    ready: items !== undefined && purchases !== undefined && !testCartPending,
    error: testCartError,
    items: items ?? [],
    purchases: purchases ?? [],
    purchasedItems,
    cartCount: countOf(items ?? []),
    addItem: async (url) => (await addItem({ url, idempotencyKey: idempotencyKey() })).itemId,
    addItemFromQuery: async (query) => {
      try {
        return await convex.action(api.cart.addItemFromQuery, { query, idempotencyKey: idempotencyKey() });
      } catch (e) {
        if (e instanceof Error && /could not find (public )?function/i.test(e.message)) throw new Error('Paste a product URL for now.');
        throw e;
      }
    },
    setQuantity: async (itemId, quantity) => {
      await setQuantity({ itemId, quantity });
    },
    removeItem: async (itemId) => {
      await removeItem({ itemId });
    },
    loadDemoCart: async () => {
      await setupMyCart({});
    },
    prepareTestCart,
    checkoutItem: async (item) => {
      const request = await placeOrder(
        item,
        async () => {
          const pending = item.pendingRequest;
          if (pending && pending.expiresAt > Date.now()) {
            const request = await convex.query(api.purchases.getPurchaseStatus, { requestId: pending.requestId });
            const matches = request.quantity === item.quantity && request.offerId === itemOffer(item)?.id;
            if (matches && request.status === 'pending_approval' && request.quote) return toPending(request);
          }
          return toPending(await requestPurchase(purchaseArgs(item)));
        },
        ({ requestId, quoteVersion }, decision) => decidePurchase({ requestId, quoteVersion, decision })
      );
      await placementOf(convex, request.requestId);
    },
  };

  return <ShopContext value={value}>{children}</ShopContext>;
}

interface Snapshot {
  items: CartItem[];
  purchases: Purchase[];
  purchasedItems: Record<string, CartItem>;
}

async function loadSnapshot(): Promise<Snapshot> {
  const [items, purchases] = await Promise.all([cartApi.listItems(), cartApi.listPurchases()]);
  const details = await Promise.all(purchases.map((p) => cartApi.getItem({ itemId: p.itemId })));
  return { items, purchases, purchasedItems: Object.fromEntries(details.map((item) => [item.id, item])) };
}

function MockShopProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const refresh = useCallback(async () => setSnapshot(await loadSnapshot()), []);

  useEffect(() => {
    loadSnapshot().then(setSnapshot);
    return cartApi.subscribe(() => loadSnapshot().then(setSnapshot));
  }, []);

  const value: ShopState = {
    live: false,
    ready: snapshot !== null,
    error: null,
    items: snapshot?.items ?? [],
    purchases: snapshot?.purchases ?? [],
    purchasedItems: snapshot?.purchasedItems ?? {},
    cartCount: countOf(snapshot?.items ?? []),
    addItem: async (url) => {
      const { itemId } = await cartApi.addItem({ url, idempotencyKey: idempotencyKey() });
      await refresh();
      return itemId;
    },
    addItemFromQuery: async (query) => {
      const result = await cartApi.addItemFromQuery({ query, idempotencyKey: idempotencyKey() });
      await refresh();
      return result;
    },
    setQuantity: async (itemId, quantity) => {
      await cartApi.setQuantity({ itemId, quantity });
      await refresh();
    },
    removeItem: async (itemId) => {
      await cartApi.removeItem({ itemId });
      await refresh();
    },
    loadDemoCart: refresh,
    prepareTestCart: () => {},
    checkoutItem: async (item) => {
      try {
        await placeOrder(
          item,
          async () => toPending(await cartApi.requestPurchase(purchaseArgs(item))),
          ({ requestId, quoteVersion }, decision) => cartApi.decidePurchase({ requestId, quoteVersion, decision })
        );
      } finally {
        await refresh();
      }
    },
  };

  return <ShopContext value={value}>{children}</ShopContext>;
}

export const ShopProvider = convexConfigured ? LiveShopProvider : MockShopProvider;

export function useShop() {
  const context = use(ShopContext);
  if (!context) throw new Error('useShop must be used inside ShopProvider');
  return context;
}

function useLiveItem(itemId: string): CartItem | undefined {
  const signedIn = useSession() === 'signed_in';
  return useQuery(api.cart.getItem, signedIn && itemId ? { itemId } : 'skip');
}

function useMockItem(itemId: string): CartItem | undefined {
  const [item, setItem] = useState<CartItem>();
  useEffect(() => {
    cartApi.getItem({ itemId }).then(setItem);
  }, [itemId]);
  return item;
}

/** One cart item with full sections and price history, kept live on Convex. */
export const useItem = convexConfigured ? useLiveItem : useMockItem;

let reviewsDeployed: boolean | undefined;

function useLiveReviews(item: CartItem | undefined) {
  const convex = useConvex();
  const [deployed, setDeployed] = useState(reviewsDeployed);
  const cartItemId = item?.id;

  useEffect(() => {
    if (deployed !== undefined || !cartItemId) return;
    convex
      .query(api.reviews.list, { cartItemId })
      .then(
        () => true,
        () => false
      )
      .then((ok) => {
        reviewsDeployed = ok;
        setDeployed(ok);
      });
  }, [convex, deployed, cartItemId]);

  const list = useQuery(api.reviews.list, deployed && cartItemId ? { cartItemId } : 'skip');
  if (!item) return undefined;
  return deployed === false ? mockReviews(item) : list;
}

function useMockReviews(item: CartItem | undefined) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 2500);
    return () => clearTimeout(timer);
  }, []);
  return item && loaded ? mockReviews(item) : undefined;
}

/**
 * reviews:list for one cart item. Until the backend deploys that query, it falls back to simulated
 * reviews, so the screen works today and switches to live data without a code change.
 */
export const useReviews: (item: CartItem | undefined) => ReviewList | undefined = convexConfigured
  ? useLiveReviews
  : useMockReviews;

function useLivePurchaseRequest(requestId: string | null | undefined) {
  const signedIn = useSession() === 'signed_in';
  return useQuery(api.purchases.getPurchaseStatus, signedIn && requestId ? { requestId } : 'skip');
}

/** purchases:getPurchaseStatus, kept live on Convex. The offline mocks have no request to read. */
export const usePurchaseRequest: (requestId: string | null | undefined) => PurchaseRequest | undefined = convexConfigured
  ? useLivePurchaseRequest
  : () => undefined;

/**
 * The item's cross-store comparison. A deployed getItem that predates the field omits it entirely, and
 * only then does the demo comparison stand in (demo: true); null from the backend means no lookup yet.
 */
/**
 * The offer the app prices and buys. A backend that reports offer availability names the new-condition
 * offer, which is null when the URL only lists used or refurbished copies; an older backend has only the saved offer.
 */
export function itemOffer(item: CartItem): Offer | null {
  return item.offerAvailability ? (item.newOffer ?? null) : item.offer;
}

export function itemComparison(item: CartItem): { comparison: PriceComparison | null; demo: boolean } {
  if (item.comparison !== undefined) return { comparison: item.comparison, demo: false };
  const comparison = mockComparison(item);
  return { comparison, demo: comparison !== null };
}
