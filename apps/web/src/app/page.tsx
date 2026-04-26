"use client";

import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { ApiError, importModList, createAnalysisSync } from "@/lib/api";
import {
  loadSession,
  getEffectiveActorId,
  getDefaultProjectId,
  saveRecentAnalysis,
} from "@/lib/session";

const LOADERS = ["fabric", "forge", "neoforge", "quilt"] as const;
const MC_VERSIONS = ["1.21.4", "1.21.1", "1.20.1", "1.19.4", "1.18.2"] as const;
const SIDES = ["both", "client", "server"] as const;

interface ModEntry {
  name: string;
  version: string;
}

interface ManifestMod {
  projectId?: number;
  filename?: string;
  name?: string;
  version?: string;
}

interface ManifestFile {
  minecraft?: {
    version?: string;
    modLoaders?: Array<{ id: string; primary?: boolean }>;
  };
  files?: ManifestMod[];
}

interface IndexMod {
  modId: string;
  version: string;
}

interface IndexFile {
  game?: string;
  mods?: IndexMod[];
}

function parseMods(raw: string): ModEntry[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(/\s+/);
      return { name, version: rest.join(" ") };
    });
}

function parseManifestOrIndexJson(json: string): ModEntry[] {
  const parsed = JSON.parse(json) as ManifestFile | IndexFile;

  if ("files" in parsed && Array.isArray(parsed.files)) {
    return parsed.files.map((file) => ({
      name: file.filename || file.name || `mod-${file.projectId ?? "unknown"}`,
      version: file.version || "unknown",
    }));
  }

  if ("mods" in parsed && Array.isArray(parsed.mods) && parsed.game === "minecraft") {
    return parsed.mods.map((mod) => ({
      name: mod.modId,
      version: mod.version || "unknown",
    }));
  }

  throw new Error("Unsupported JSON format. Expected manifest.json or index.json.");
}

export default function HomePage() {
  const router = useRouter();

  const [mcVersion, setMcVersion] = useState("1.21.1");
  const [loader, setLoader] = useState("fabric");
  const [javaVersion, setJavaVersion] = useState("21");
  const [side, setSide] = useState("both");
  const [modsText, setModsText] = useState(
    "sodium 0.6.0+mc1.21.1\nmodmenu 11.0.2\nclothconfig 15.0.127+mc1.21.1\n"
  );
  const [modInputMode, setModInputMode] = useState<"plain" | "json">("json");
  const [jsonContent, setJsonContent] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    setIsLoggedIn(!!loadSession());
  }, []);

  async function handleRunAnalysis(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    let mods: ModEntry[] = [];
    try {
      mods =
        modInputMode === "json"
          ? parseManifestOrIndexJson(jsonContent)
          : parseMods(modsText);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Invalid mod input.");
      setLoading(false);
      return;
    }

    if (mods.length === 0) {
      setError("Enter at least one mod.");
      setLoading(false);
      return;
    }

    const actorId = getEffectiveActorId();
    const projectId = getDefaultProjectId() ?? "demo";

    try {
      const environment = {
        minecraftVersion: mcVersion,
        loader,
        javaVersion,
        side,
      };

      const importResult = await importModList(projectId, {
        environment,
        mods,
        createdBy: actorId,
      });

      const snapshotId = importResult.snapshot?.packSnapshotId ?? "";

      const analysis = await createAnalysisSync(projectId, {
        trigger: "manual",
        analysisMode: "standard",
        inputRef: { type: "pack_snapshot", id: snapshotId },
        environment: {
          minecraftVersion: mcVersion,
          loader: loader as import("@modcompat/domain-models").Loader,
          javaVersion,
          side: side as import("@modcompat/domain-models").Side,
        },
        options: { runSimulation: true, includeAlternatives: true },
      });

      saveRecentAnalysis({
        analysisId: analysis.analysisId,
        projectId,
        createdAt: new Date().toISOString(),
        label: `${mods.length} mods · ${loader} ${mcVersion}`,
      });

      router.push(`/projects/${projectId}/analyses/${analysis.analysisId}/progress`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setLoading(false);
    }
  }

  function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setJsonContent(content);
    };
    reader.readAsText(file);
  }

  return (
    <div className="min-h-screen bg-mc-bg">
      {/* Top nav */}
      <header className="border-b-2 border-mc-border bg-mc-panel">
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl" aria-hidden>⛏</span>
            <span className="font-minecraft text-2xl text-mc-green tracking-widest text-shadow-mc">
              MODPACK CHECKER
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isLoggedIn ? (
              <Link
                href="/dashboard"
                className="mc-btn text-base px-4 py-1"
              >
                My Dashboard
              </Link>
            ) : (
              <Link
                href="/sign-in"
                className="mc-btn text-base px-4 py-1"
              >
                Sign In
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 space-y-8">

        {/* ── SECTION 1: Explanation ── */}
        <section className="mc-panel space-y-5">
          <div className="flex items-center gap-3 border-b-2 border-mc-stone-dark pb-4">
            <span className="text-4xl" aria-hidden>🧱</span>
            <div>
              <h1 className="font-minecraft text-3xl text-mc-green tracking-wider">
                WHAT IS THIS?
              </h1>
              <p className="text-mc-text-muted text-base mt-1">
                A free tool to check your Minecraft mod list for compatibility issues.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="mc-panel-inner space-y-1">
              <p className="text-mc-green font-minecraft text-lg tracking-wide">⚠ DETECTS CONFLICTS</p>
              <p className="text-mc-text-muted text-base">
                Finds version mismatches, loader incompatibilities, and known mod clashes
                before you launch your game.
              </p>
            </div>
            <div className="mc-panel-inner space-y-1">
              <p className="text-mc-green font-minecraft text-lg tracking-wide">🔧 SUGGESTS FIXES</p>
              <p className="text-mc-text-muted text-base">
                Recommends compatible replacements and version upgrades to resolve
                detected issues.
              </p>
            </div>
            <div className="mc-panel-inner space-y-1">
              <p className="text-mc-green font-minecraft text-lg tracking-wide">⚡ INSTANT RESULTS</p>
              <p className="text-mc-text-muted text-base">
                No account needed. Paste your mod list and get results in seconds.
                Your data is only kept while your browser tab is open.
              </p>
            </div>
            <div className="mc-panel-inner space-y-1">
              <p className="text-mc-green font-minecraft text-lg tracking-wide">💾 SAVE WITH ACCOUNT</p>
              <p className="text-mc-text-muted text-base">
                Optionally sign in to save your analyses and access them later
                across sessions.
              </p>
            </div>
          </div>

          <div className="mc-panel-inner">
            <p className="font-minecraft text-xl text-mc-gold tracking-wide mb-3">HOW TO USE:</p>
            <ol className="space-y-2 text-base text-mc-text-muted list-none">
              <li className="flex items-start gap-2">
                <span className="text-mc-green font-minecraft text-lg">[1]</span>
                <span>Select your <strong className="text-mc-text">Minecraft version</strong>, mod loader, Java version, and side below.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-mc-green font-minecraft text-lg">[2]</span>
                <span>Paste your <strong className="text-mc-text">mod list</strong> — one mod per line, in the format <code className="bg-mc-stone-dark px-1 py-0.5 text-mc-green text-sm">modname version</code>.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-mc-green font-minecraft text-lg">[3]</span>
                <span>Click <strong className="text-mc-green">RUN ANALYSIS</strong> and wait for the compatibility report.</span>
              </li>
            </ol>
          </div>
        </section>

        {/* ── SECTION 2: Analysis Form ── */}
        <section>
          <form onSubmit={handleRunAnalysis} className="space-y-5">

            {/* Environment */}
            <div className="mc-panel">
              <h2 className="font-minecraft text-xl text-mc-green tracking-wider uppercase mb-4 pb-2 border-b-2 border-mc-stone-dark">
                ⚙ Environment
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block">
                  <span className="mc-label">MC Version</span>
                  <select
                    value={mcVersion}
                    onChange={(e) => setMcVersion(e.target.value)}
                    className="mc-select"
                  >
                    {MC_VERSIONS.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mc-label">Loader</span>
                  <select
                    value={loader}
                    onChange={(e) => setLoader(e.target.value)}
                    className="mc-select"
                  >
                    {LOADERS.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mc-label">Java Version</span>
                  <select
                    value={javaVersion}
                    onChange={(e) => setJavaVersion(e.target.value)}
                    className="mc-select"
                  >
                    {["21", "17", "11", "8"].map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mc-label">Side</span>
                  <select
                    value={side}
                    onChange={(e) => setSide(e.target.value)}
                    className="mc-select"
                  >
                    {SIDES.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {/* Mod List */}
            <div className="mc-panel">
              <h2 className="font-minecraft text-xl text-mc-green tracking-wider uppercase mb-2 pb-2 border-b-2 border-mc-stone-dark">
                📦 Mod List
              </h2>
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setModInputMode("json")}
                  className={`mc-btn text-sm px-3 py-1 ${modInputMode === "json" ? "ring-2 ring-mc-green" : ""}`}
                >
                  manifest/index JSON
                </button>
                <button
                  type="button"
                  onClick={() => setModInputMode("plain")}
                  className={`mc-btn text-sm px-3 py-1 ${modInputMode === "plain" ? "ring-2 ring-mc-green" : ""}`}
                >
                  Plain list
                </button>
              </div>

              {modInputMode === "json" ? (
                <>
                  <p className="text-mc-text-muted text-base mb-3">
                    Upload your `manifest.json` / `index.json`, or paste its full content.
                  </p>
                  <div className="mb-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="mc-btn text-base px-4 py-2"
                    >
                      📁 Choose JSON File
                    </button>
                  </div>
                  <textarea
                    value={jsonContent}
                    onChange={(e) => setJsonContent(e.target.value)}
                    rows={10}
                    className="mc-input font-minecraft resize-y"
                    placeholder="Paste your manifest.json or index.json content here..."
                    style={{ fontSize: "15px" }}
                  />
                </>
              ) : (
                <>
                  <p className="text-mc-text-muted text-base mb-3">
                    One mod per line — format: <code className="bg-mc-stone-dark px-1 text-mc-green">sodium 0.6.0+mc1.21.1</code>
                  </p>
                  <textarea
                    value={modsText}
                    onChange={(e) => setModsText(e.target.value)}
                    rows={10}
                    className="mc-input font-minecraft resize-y"
                    placeholder={"sodium 0.6.0+mc1.21.1\nmodmenu 11.0.2\nclothconfig 15.0.127+mc1.21.1"}
                    style={{ fontSize: "18px" }}
                  />
                  <p className="text-mc-text-dim text-sm mt-2">
                    {parseMods(modsText).length} mod{parseMods(modsText).length !== 1 ? "s" : ""} detected
                  </p>
                </>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="mc-error-box">
                <p className="text-mc-danger font-minecraft text-lg">⛔ ERROR</p>
                <p className="text-base mt-1">{error}</p>
              </div>
            )}

            {/* Submit */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <button
                type="submit"
                disabled={loading}
                className="mc-btn-primary text-2xl px-8 py-3 tracking-widest font-minecraft disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    ANALYZING...
                  </span>
                ) : (
                  "▶ RUN ANALYSIS"
                )}
              </button>

              {!isLoggedIn && (
                <p className="text-mc-text-dim text-base">
                  No account needed.{" "}
                  <Link href="/sign-in" className="text-mc-green hover:underline">
                    Sign in
                  </Link>{" "}
                  to save your results.
                </p>
              )}
            </div>
          </form>
        </section>
      </main>

      <footer className="border-t-2 border-mc-border mt-12">
        <div className="mx-auto max-w-4xl px-4 py-4 text-center text-mc-text-dim text-sm font-minecraft tracking-wide">
          DATA IS STORED IN YOUR BROWSER ONLY AND CLEARED WHEN YOU CLOSE THE TAB.
        </div>
      </footer>
    </div>
  );
}
