export const TEST_USER = {
  email: process.env.EXPO_PUBLIC_TEST_USER_EMAIL ?? 'xm6-demo@cart-demo.test',
  password: process.env.EXPO_PUBLIC_TEST_USER_PASSWORD ?? 'cart-demo-2026',
};

export const TEST_USER_ITEM_URL = 'https://www.amazon.com/dp/B0F3PQHWTZ';

export function isTestUserItem(url: string) {
  try {
    const parsed = new URL(url);
    return /(^|\.)amazon\.com$/i.test(parsed.hostname)
      && /\/(?:dp|gp\/product|product-reviews)\/B0F3PQHWTZ(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}
