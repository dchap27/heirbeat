import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "../components/AppShell";
import { pathForView, viewForPath, type AppView } from "./app-navigation";

function shell(view: AppView, hasVault: boolean) {
  return renderToStaticMarkup(<AppShell
    view={view}
    hasVault={hasVault}
    connected={false}
    address={null}
    connecting={false}
    onNavigate={() => {}}
    onConnect={() => {}}
    onDisconnect={() => {}}
  >content</AppShell>);
}

describe("app navigation", () => {
  it("keeps the brand linked to home and Home available while a vault is open", () => {
    const html = shell("dashboard", true);
    expect(html).toContain('class="brand" href="/"');
    expect(html).toContain(">Home</button>");
    expect(html).toContain(">Dashboard</button>");
  });

  it("shows Dashboard only when a vault is loaded", () => {
    expect(shell("home", false)).not.toContain(">Dashboard</button>");
    expect(shell("open", false)).not.toContain(">Dashboard</button>");
    expect(shell("dashboard", true)).toContain(">Dashboard</button>");
  });

  it.each([
    ["/", "home"],
    ["/vault/0xc01fe4f8003940514cdfc0bb2be577", "dashboard"],
    ["/open-vault", "open"],
    ["/create-vault", "create"],
  ] as const)("maps %s to the %s navigation state", (path, expected) => {
    expect(viewForPath(path)).toBe(expected);
  });

  it("marks Open vault and Create vault active on their screens", () => {
    expect(shell("open", false)).toContain('class="nav-link active" aria-current="page"');
    expect(shell("create", false)).toContain(">Create vault</button>");
    expect(shell("create", false)).toContain('class="nav-link active" aria-current="page"');
  });

  it("generates shareable vault and navigation paths", () => {
    expect(pathForView("dashboard", "0xc01fe4f8003940514cdfc0bb2be577")).toBe("/vault/0xc01fe4f8003940514cdfc0bb2be577");
    expect(pathForView("home")).toBe("/");
    expect(pathForView("open")).toBe("/open-vault");
    expect(pathForView("create")).toBe("/create-vault");
  });
});
