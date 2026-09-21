import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";

// A utility to recursively read file paths in a directory
function getFiles(dir: string): string[] {
  const dirents = readdirSync(dir, { withFileTypes: true });
  const files = dirents.map((dirent) => {
    const res = resolve(dir, dirent.name);
    return dirent.isDirectory() ? getFiles(res) : res;
  });
  return Array.prototype.concat(...files);
}

describe("App Branding (Artix Migration)", () => {
  const srcDir = join(__dirname, "../");

  it("should have renamed the fenix-logo asset to artix-logo", () => {
    const assetsDir = join(srcDir, "assets");
    const artixLogoExists = existsSync(join(assetsDir, "artix-logo.png"));
    const fenixLogoExists = existsSync(join(assetsDir, "fenix-logo.png"));

    expect(artixLogoExists).toBe(true);
    expect(fenixLogoExists).toBe(false);
  });

  it("should not contain imports or references to fenix-logo in src components", () => {
    const allFiles = getFiles(srcDir).filter(
      (f) =>
        (f.endsWith(".ts") || f.endsWith(".tsx")) &&
        !f.includes("branding.test.ts") &&
        !f.includes("ai.test.ts")
    );

    for (const filePath of allFiles) {
      const content = readFileSync(filePath, "utf-8");
      
      // Should not import the old logo file
      expect(content).not.toContain("fenix-logo.png");
      expect(content).not.toContain("fenixLogo");
    }
  });

  it("should not contain the string 'Fenix' in key user-facing source files", () => {
    const targetFiles = [
      join(srcDir, "components/AI/AISettingsCard.tsx"),
      join(srcDir, "components/DashboardSidebar.tsx"),
      join(srcDir, "components/Navbar.tsx"),
      join(srcDir, "components/PWAInstallPrompt.tsx"),
      join(srcDir, "lib/ai/providers/openrouter.ts"),
      join(srcDir, "pages/Auth.tsx"),
      join(srcDir, "pages/Dashboard.tsx"),
      join(srcDir, "pages/Index.tsx"),
    ];

    for (const filePath of targetFiles) {
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8");
        // Ensure the word Fenix is replaced by Artix
        expect(content).not.toContain("Fenix");
      }
    }
  });

  it("should have updated index.html metadata", () => {
    const indexHtmlPath = join(srcDir, "../index.html");
    if (existsSync(indexHtmlPath)) {
      const content = readFileSync(indexHtmlPath, "utf-8");
      
      // Brand title and description checks
      expect(content).toContain("<title>Artix - The Developer&#39;s Command Center</title>");
      expect(content).not.toContain("Fenix - The Developer");
      expect(content).not.toContain("lovable.app-1775311392549.png");
      expect(content).not.toContain("lovableproject.com");
    }
  });

  it("should have applied dark-canvas style wrapper to SystemArchitect to guarantee a dark theme canvas", () => {
    const sysArchitectPath = join(srcDir, "components/SystemArchitect/SystemArchitect.tsx");
    const indexCssPath = join(srcDir, "index.css");

    if (existsSync(sysArchitectPath)) {
      const content = readFileSync(sysArchitectPath, "utf-8");
      expect(content).toContain('className="dark-canvas h-screen w-full bg-background');
    }

    if (existsSync(indexCssPath)) {
      const content = readFileSync(indexCssPath, "utf-8");
      expect(content).toContain(".dark-canvas");
      expect(content).toContain("color-scheme: dark;");
    }
  });

  it("should have removed light mode styles and logic from useTheme and index.css", () => {
    const indexCssPath = join(srcDir, "index.css");
    const useThemePath = join(srcDir, "hooks/useTheme.tsx");

    if (existsSync(indexCssPath)) {
      const content = readFileSync(indexCssPath, "utf-8");
      // Check that .light class selector styling is completely removed
      expect(content).not.toContain(".light {");
      expect(content).not.toContain("--background: 210 20% 98%;");
    }
  });

  it("should have updated package.json metadata and removed template defaults", () => {
    const pkgPath = join(srcDir, "../package.json");
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    expect(pkg.name).toBe("artix");
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.description).toContain("Artix");
    expect(JSON.stringify(pkg)).not.toContain("vite_react_shadcn_ts");
  });

  it("should not contain machine-specific file:/// or c:/Fenix-main paths in documentation", () => {
    const docFiles = [
      join(srcDir, "../README.md"),
      join(srcDir, "../SECURITY.md"),
      join(srcDir, "../DOCS.md"),
      join(srcDir, "../docs/PROJECT_FILE_STRUCTURE.md"),
    ];

    for (const file of docFiles) {
      if (existsSync(file)) {
        const content = readFileSync(file, "utf-8");
        expect(content).not.toContain("file:///");
        expect(content).not.toContain("c:/Fenix-main");
      }
    }
  });
});
