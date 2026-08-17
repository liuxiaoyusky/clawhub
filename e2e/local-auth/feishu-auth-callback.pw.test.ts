import { expect, test } from "@playwright/test";

test.skip(
  process.env.VITE_ENABLE_DEV_AUTH !== "1",
  "Feishu callback browser regression test requires the local auth runner",
);

test("failed Feishu sign-in removes the ticket from the browser URL", async ({ page }) => {
  const ticket = "f".repeat(64);
  const traceId = "auth_123e4567-e89b-42d3-a456-426614174000";

  await page.goto(`/auth/feishu#ticket=${ticket}&trace=${traceId}&next=%2Fskills%3Fq%3Dpadel`, {
    waitUntil: "domcontentloaded",
  });

  await expect(page).toHaveURL(/\/auth\/feishu$/);
  await expect(page.getByRole("status")).toHaveText(
    `Sign-in could not be completed. Please try again. Reference: ${traceId}`,
  );
  expect(page.url()).not.toContain(ticket);
  await expect(page.locator("body")).not.toContainText(ticket);
});
