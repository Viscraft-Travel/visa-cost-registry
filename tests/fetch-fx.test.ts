import { describe, it, expect } from "vitest";
import { pctChange, findExcessiveMoves, type FxData } from "../scripts/fetch-fx.js";

function fxData(rates: Partial<FxData["rates"]>): FxData {
  return {
    base: "INR",
    fetched_at: "2026-09-19T00:30:00.000Z",
    as_of: "2026-09-19",
    source: "https://api.frankfurter.dev/v1/latest",
    rates: {
      EUR: 100,
      GBP: 120,
      USD: 90,
      CAD: 65,
      AUD: 65,
      NZD: 55,
      CNY: 14,
      JPY: 0.6,
      ...rates,
    },
  };
}

describe("pctChange", () => {
  it("computes an unsigned percentage change", () => {
    expect(pctChange(100, 105)).toBeCloseTo(5, 5);
    expect(pctChange(100, 95)).toBeCloseTo(5, 5);
  });
});

describe("findExcessiveMoves", () => {
  it("returns nothing on the very first run (no previous data to compare)", () => {
    const next = fxData({}).rates;
    expect(findExcessiveMoves(null, next)).toEqual([]);
  });

  it("returns nothing when every currency moves 5% or less", () => {
    const previous = fxData({});
    const next = { ...previous.rates, EUR: 104.9 }; // 4.9% move, under threshold
    expect(findExcessiveMoves(previous, next)).toEqual([]);
  });

  it("flags a currency that moves more than 5%, and only that one", () => {
    const previous = fxData({});
    const next = { ...previous.rates, EUR: 110 }; // 10% move
    const moves = findExcessiveMoves(previous, next);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ currency: "EUR", old: 100, new: 110 });
    expect(moves[0].pct).toBeCloseTo(10, 5);
  });

  it("flags every currency that exceeds the threshold, not just the first", () => {
    const previous = fxData({});
    const next = { ...previous.rates, EUR: 110, GBP: 132 }; // both 10% moves
    const moves = findExcessiveMoves(previous, next);
    expect(moves.map((m) => m.currency).sort()).toEqual(["EUR", "GBP"]);
  });
});
