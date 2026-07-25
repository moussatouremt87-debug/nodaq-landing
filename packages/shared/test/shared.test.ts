import { describe, expect, it } from "vitest";
import { CreateNoteInput, TenantId, assert } from "../src/index.js";

describe("@nodaq/shared", () => {
  it("TenantId accepte un uuid et rejette le reste", () => {
    expect(TenantId.safeParse("d9c1b6a0-9a5e-4c3f-8f21-0b6a4a1d2e3f").success).toBe(true);
    expect(TenantId.safeParse("pas-un-uuid").success).toBe(false);
    expect(TenantId.safeParse("").success).toBe(false);
  });

  it("CreateNoteInput valide le payload", () => {
    expect(CreateNoteInput.safeParse({ title: "t", body: "b" }).success).toBe(true);
    expect(CreateNoteInput.safeParse({ title: "", body: "b" }).success).toBe(false);
  });

  it("assert jette avec le message", () => {
    expect(() => assert(false, "boom")).toThrow(/boom/);
    expect(() => assert(true, "ok")).not.toThrow();
  });
});
