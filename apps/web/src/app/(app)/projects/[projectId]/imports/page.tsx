"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

import { ApiError, createAnalysisSync, importModList, resolveMods } from "@/lib/api";
import { getCurrentActorId, getEffectiveActorId, saveRecentAnalysis } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";

const LOADERS = ["fabric", "forge", "neoforge", "quilt"] as const;
const MC_VERSIONS = ["1.21.4", "1.21.1", "1.20.1", "1.19.4", "1.18.2"] as const;
const SIDES = ["both", "client", "server"] as const;

interface ModEntry {
  name: string;
  version: string;
  curseforgeProjectId?: number;
  modrinthProjectId?: string;
}

interface ManifestMod {
  projectId?: number;
  fileID?: number;
  required?: boolean;
  downloadUrl?: string;
  filename?: string;
  name?: string;
  version?: string;
}

interface ManifestFile {
  minecraft: {
    version: string;
    modLoaders: Array<{ id: string; primary: boolean }>;
  };
  files: ManifestMod[];
}

interface IndexMod {
  modId: string;
  version: string;
}

interface IndexFile {
  formatVersion: number;
  game: string;
  version: string;
  mods: IndexMod[];
}

export default function ImportPage({ params }: { params: { projectId: string } }) {
  const router = useRouter();
  const { projectId } = params;

  const [mcVersion, setMcVersion] = useState("1.21.1");
  const [loader, setLoader] = useState("fabric");
  const [javaVersion, setJavaVersion] = useState("21");
  const [side, setSide] = useState("both");
  const [jsonContent, setJsonContent] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    snapshotId: string;
    modCount: number;
  } | null>(null);
  const [resolvedMods, setResolvedMods] = useState<any[]>([]);
  const [isResolving, setIsResolving] = useState(false);
  const [showResolvedInfo, setShowResolvedInfo] = useState(false);

  
  function parseManifestJson(json: string): ModEntry[] {
    try {
      const manifest = JSON.parse(json) as ManifestFile;
      return manifest.files.map((file) => ({
        name: file.filename || file.name || `mod-${file.projectId}`,
        version: file.version || "unknown",
        curseforgeProjectId: file.projectId,
      }));
    } catch (error) {
      throw new Error("Invalid manifest.json format");
    }
  }

  function parseIndexJson(json: string): ModEntry[] {
    try {
      const index = JSON.parse(json) as IndexFile;
      return index.mods.map((mod) => ({
        name: mod.modId,
        version: mod.version,
        modrinthProjectId: mod.modId,
      }));
    } catch (error) {
      throw new Error("Invalid index.json format");
    }
  }

  function parseJson(json: string): ModEntry[] {
    try {
      const parsed = JSON.parse(json);
      
      // Try to detect format
      if (parsed.files && Array.isArray(parsed.files) && parsed.minecraft) {
        return parseManifestJson(json);
      } else if (parsed.mods && Array.isArray(parsed.mods) && parsed.game === "minecraft") {
        return parseIndexJson(json);
      } else {
        throw new Error("Unsupported JSON format. Expected manifest.json or index.json");
      }
    } catch (error) {
      throw new Error("Invalid JSON format");
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

  async function handleResolveMods() {
    const mods = parseJson(jsonContent);

    if (mods.length === 0) {
      setError("Please upload or paste a valid manifest.json or index.json file.");
      return;
    }

    setIsResolving(true);
    setError(null);

    try {
      const result = await resolveMods({
        mods: mods.map((m) => ({
          name: m.name,
          curseforgeProjectId: m.curseforgeProjectId,
          modrinthProjectId: m.modrinthProjectId,
        })),
        minecraftVersion: mcVersion,
        loader: loader,
      });

      setResolvedMods(result.mods);
      setShowResolvedInfo(true);
      
      if (result.totalFound === 0) {
        setError("No mods found on CurseForge or Modrinth.");
      } else if (result.totalFound < result.totalRequested) {
        setError(`Found ${result.totalFound} of ${result.totalRequested} mods.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setIsResolving(false);
    }
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setImportResult(null);

    try {
      const actorId = getCurrentActorId() ?? getEffectiveActorId();

      const mods = parseJson(jsonContent);
      if (mods.length === 0) {
        setError("Enter at least one mod.");
        setLoading(false);
        return;
      }

      const result = await importModList(projectId, {
        environment: { minecraftVersion: mcVersion, loader, javaVersion, side },
        mods,
        createdBy: actorId,
      });

      const snapshotId = result.snapshot?.packSnapshotId ?? "";
      setImportResult({ snapshotId, modCount: mods.length });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleAnalyse() {
    if (!importResult?.snapshotId) return;

    setLoading(true);
    setError(null);

    try {
      const result = await createAnalysisSync(projectId, {
        trigger: "manual",
        analysisMode: "standard",
        inputRef: { type: "pack_snapshot", id: importResult.snapshotId },
        environment: {
          minecraftVersion: mcVersion,
          loader: loader as import("@modcompat/domain-models").Loader,
          javaVersion,
          side: side as import("@modcompat/domain-models").Side,
        },
        options: { runSimulation: true, includeAlternatives: true },
      });

      saveRecentAnalysis({
        analysisId: result.analysisId,
        projectId,
        createdAt: new Date().toISOString(),
        label: `${importResult.modCount} mods · ${loader} ${mcVersion}`,
      });
      router.push(`/projects/${projectId}/analyses/${result.analysisId}/progress`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-minecraft text-3xl text-mc-green tracking-wider mb-1">IMPORT PACK</h1>
      <p className="text-mc-text-muted text-lg mb-6">
        Paste your mod list, configure the environment, and create a snapshot for analysis.
      </p>

      <form onSubmit={handleImport} className="space-y-5">
        <Card>
          <CardHeader title="⚙ Environment" />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mc-label">Minecraft Version</span>
              <select
                value={mcVersion}
                onChange={(e) => setMcVersion(e.target.value)}
                className="mc-select"
              >
                {MC_VERSIONS.map((version) => (
                  <option key={version}>{version}</option>
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
                {LOADERS.map((value) => (
                  <option key={value}>{value}</option>
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
                {["21", "17", "11", "8"].map((value) => (
                  <option key={value}>{value}</option>
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
                {SIDES.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="📦 Mod List"
            subtitle="Upload manifest.json/index.json file or paste its content"
          />
          
          <div className="space-y-4">
            <div>
              <p className="text-sm text-mc-text-muted mb-2">
                Upload your manifest.json or index.json file
              </p>
              <div className="flex gap-4">
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
                  className="px-4 py-2 bg-blue-500 text-white rounded font-minecraft hover:bg-blue-600 transition-colors"
                >
                  📁 Choose File
                </button>
              </div>
            </div>
            
            <div>
              <p className="text-sm text-mc-text-muted mb-2">
                Or paste the content of your manifest.json or index.json file:
              </p>
              <textarea
                value={jsonContent}
                onChange={(e) => setJsonContent(e.target.value)}
                rows={10}
                className="mc-input font-minecraft resize-y"
                style={{ fontSize: "14px" }}
                placeholder="Paste your manifest.json or index.json content here..."
              />
            </div>
          </div>
        </Card>

        <div className="flex gap-4">
          <Button
            type="button"
            variant="secondary"
            loading={isResolving}
            onClick={handleResolveMods}
            disabled={loading}
          >
            {isResolving ? "Resolving..." : "Resolve Mods"}
          </Button>
        </div>

        {showResolvedInfo && resolvedMods.length > 0 && (
          <Card>
            <CardHeader
              title="Resolved Mods"
              subtitle={`Found ${resolvedMods.length} mods from CurseForge and Modrinth`}
            />
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {resolvedMods.map((mod, index) => (
                <div key={mod.id || index} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-minecraft text-mc-green">{mod.name}</h3>
                        <Badge label={mod.source} variant="status" severity={mod.source === "curseforge" ? "info" : "warning"} />
                      </div>
                      <p className="text-sm text-mc-text-muted mb-2">{mod.description}</p>
                      <div className="flex flex-wrap gap-4 text-xs text-mc-text-muted">
                        <span>Version: {mod.version}</span>
                        <span>Downloads: {mod.downloads?.toLocaleString()}</span>
                        {mod.author && <span>Author: {mod.author}</span>}
                      </div>
                      {mod.dependencies && mod.dependencies.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs font-minecraft text-mc-text-muted mb-1">Dependencies:</p>
                          <div className="flex flex-wrap gap-1">
                            {mod.dependencies.map((dep: any, depIndex: number) => (
                              <Badge
                                key={depIndex}
                                label={dep.name}
                                variant="status"
                                severity={dep.required ? "danger" : "neutral"}
                                className="text-xs"
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {mod.iconUrl && (
                      <img
                        src={mod.iconUrl}
                        alt={mod.name}
                        className="w-12 h-12 rounded-lg ml-3"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {error && (
          <div className="mc-error-box">
            <p className="font-minecraft text-mc-danger text-lg">⛔ ERROR</p>
            <p className="text-base mt-1">{error}</p>
          </div>
        )}

        {importResult && (
          <div className="mc-success-box space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-minecraft text-mc-green text-xl">✔ IMPORT SUCCESSFUL</span>
              <Badge label={`${importResult.modCount} mods`} />
            </div>
            <p className="font-minecraft text-sm text-mc-text-muted break-all">{importResult.snapshotId}</p>
            <Button variant="primary" type="button" loading={loading} onClick={handleAnalyse}>
              ▶ Run Analysis
            </Button>
          </div>
        )}

        {!importResult && (
          <Button type="submit" variant="primary" loading={loading}>
            Import Pack
          </Button>
        )}
      </form>
    </div>
  );
}
