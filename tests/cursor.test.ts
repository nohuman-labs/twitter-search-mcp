import { expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/domain/cursor.js";

it("binds cursors to provider, tool, and query", () => {
  const cursor = encodeCursor({
    v: 1,
    tool: "search_posts",
    provider: "x",
    query: "cats",
    continuation: "n1",
  });

  expect(() =>
    decodeCursor(cursor, {
      tool: "search_posts",
      provider: "x",
      query: "dogs",
    }),
  ).toThrow(/context/i);
});

it("round-trips valid cursors", () => {
  const cursor = encodeCursor({
    v: 1,
    tool: "search_profiles",
    provider: "twitee",
    query: "creators",
    continuation: { page: 2, generation: "g1" },
  });

  expect(
    decodeCursor(cursor, {
      tool: "search_profiles",
      provider: "twitee",
      query: "creators",
    }),
  ).toEqual({ page: 2, generation: "g1" });
});

it("round-trips Unicode cursor context and continuation", () => {
  const cursor = encodeCursor({
    v: 1,
    tool: "search_posts",
    provider: "x",
    query: "m\u00e8o \ud83d\ude3a",
    continuation: { page_marker: "ti\u1ebfp \ud83d\ude80" },
  });

  expect(
    decodeCursor(cursor, {
      tool: "search_posts",
      provider: "x",
      query: "m\u00e8o \ud83d\ude3a",
    }),
  ).toEqual({ page_marker: "ti\u1ebfp \ud83d\ude80" });
});

it("rejects malformed cursors", () => {
  expect(() =>
    decodeCursor("not-base64url", {
      tool: "search_posts",
      provider: "x",
      query: "cats",
    }),
  ).toThrow(/cursor/i);
});
