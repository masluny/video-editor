import { describe, expect, it } from "vitest";
import { keyLabel } from "./format";

describe("keyLabel (off macOS)", () => {
  it("spells out modifier symbols", () => {
    expect(keyLabel("⇧⌘S")).toBe("Shift+Ctrl+S");
    expect(keyLabel("⌥← / ⌥→")).toBe("Alt+← / Alt+→");
    expect(keyLabel("⌘-drag edge")).toBe("Ctrl-drag edge");
    expect(keyLabel("Space")).toBe("Space");
  });
});
