-- Migration 010: Fix revenue items incorrectly counted as Amazon fees
--
-- Problem: The profit engine's buildFeeMap() fetches ALL ShipmentEvent records
-- from financial_events_raw, including both ItemChargeList (revenue: Principal,
-- Tax, ShippingCharge, etc.) and ItemFeeList (fees: Commission, FBA, etc.).
-- The otherFees calculation in computeOrderProfit() was counting revenue items
-- as Amazon fees because they were not in the knownFeeTypes exclusion list.
-- This caused total_amazon_fees to exceed revenue (e.g., 57K fees on 53K revenue).
--
-- Fix: The code now excludes revenue charge types and uses sign-based filtering
-- (only negative amounts are fees). Purge computed tables to force recomputation.

TRUNCATE order_profit;
TRUNCATE asin_daily_metrics;
TRUNCATE account_daily_kpi;
