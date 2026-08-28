import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const loadYaml = async (path: string) => parse(await readFile(path, "utf8"));

describe("Kubernetes manifests", () => {
  it("runs non-root and mounts the YAML configuration read-only", async () => {
    const deployment = await loadYaml("deploy/kubernetes/base/deployment.yaml");
    const container = deployment.spec.template.spec.containers[0];

    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy.rollingUpdate).toEqual({
      maxSurge: 1,
      maxUnavailable: 0,
    });
    expect(deployment.spec.template.spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container.args).toEqual([
      "dist/runtimes/node.js",
      "--config",
      "/config/mcp.config.yaml",
      "--host",
      "0.0.0.0",
      "--port",
      "3000",
    ]);
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
    });
    expect(container.volumeMounts).toContainEqual(
      expect.objectContaining({ mountPath: "/config", readOnly: true }),
    );
    expect(container.livenessProbe.httpGet.path).toBe("/healthz");
    expect(container.readinessProbe.httpGet.path).toBe("/readyz");
  });

  it("provides a credential-free Twitee configuration through a ConfigMap", async () => {
    const configMap = await loadYaml("deploy/kubernetes/base/configmap.yaml");
    const config = parse(configMap.data["mcp.config.yaml"]);

    expect(configMap.kind).toBe("ConfigMap");
    expect(config.access).toEqual({ mode: "anonymous", token: "" });
    expect(config.providers.twitee).toMatchObject({
      enabled: true,
      base_url: "https://twitee.co",
      token: "",
    });
    expect(config.providers.x).toMatchObject({ enabled: false, token: "" });
  });
});
