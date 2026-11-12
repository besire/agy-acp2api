package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Registry struct {
	SchemaVersion int      `json:"schema_version"`
	Plugins       []Plugin `json:"plugins"`
}

type Plugin struct {
	ID          string                  `json:"id"`
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	Author      string                  `json:"author"`
	Version     string                  `json:"version"`
	Repository  string                  `json:"repository"`
	Homepage    string                  `json:"homepage"`
	License     string                  `json:"license"`
	Tags        []string                `json:"tags"`
	Locales     map[string]PluginLocale `json:"locales"`
	Install     InstallPlan             `json:"install"`
}

type PluginLocale struct {
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

type InstallPlan struct {
	Type      string     `json:"type"`
	Artifacts []Artifact `json:"artifacts"`
}

type Artifact struct {
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func main() {
	distDir := flag.String("dist", "dist", "directory containing built zip archives")
	version := flag.String("version", "0.1.0", "plugin version without leading v")
	baseURL := flag.String("base-url", "", "base raw URL for direct artifact downloads")
	outPath := flag.String("out", "registry.json", "output registry.json path")
	flag.Parse()

	entries, err := os.ReadDir(*distDir)
	if err != nil {
		fatalf("read dist dir: %v", err)
	}

	var artifacts []Artifact
	prefix := fmt.Sprintf("agy-acp2api_%s_", *version)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".zip") {
			continue
		}
		rest := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".zip")
		parts := strings.Split(rest, "_")
		if len(parts) != 2 {
			continue
		}
		goos, goarch := parts[0], parts[1]
		fullPath := filepath.Join(*distDir, name)
		data, err := os.ReadFile(fullPath)
		if err != nil {
			fatalf("read %s: %v", fullPath, err)
		}
		sum := sha256.Sum256(data)
		artifacts = append(artifacts, Artifact{
			GOOS:   goos,
			GOARCH: goarch,
			URL:    strings.TrimRight(*baseURL, "/") + "/" + name,
			SHA256: hex.EncodeToString(sum[:]),
			Size:   int64(len(data)),
		})
	}

	sort.Slice(artifacts, func(i, j int) bool {
		if artifacts[i].GOOS != artifacts[j].GOOS {
			return artifacts[i].GOOS < artifacts[j].GOOS
		}
		return artifacts[i].GOARCH < artifacts[j].GOARCH
	})

	reg := Registry{
		SchemaVersion: 2,
		Plugins: []Plugin{
			{
				ID:          "agy-acp2api",
				Name:        "agy-acp2api",
				Description: "Bridges the local Antigravity ACP Gateway (agy-acp2api) and embeds its Material Design 3 web console into CLIProxyAPI.",
				Author:      "besire",
				Version:     *version,
				Repository:  "https://github.com/besire/agy-acp2api",
				Homepage:    "https://github.com/besire/agy-acp2api",
				License:     "MIT",
				Tags:        []string{"Provider", "Management"},
				Locales: map[string]PluginLocale{
					"zh-CN": {
						Name:        "agy-acp2api 网关控制台",
						Description: "将本地 Antigravity ACP 网关与 MD3 Web 控制台桥接至 CLIProxyAPI，支持在 CPA 管理后台直接渲染控制台并调用模型。",
					},
				},
				Install: InstallPlan{
					Type:      "direct",
					Artifacts: artifacts,
				},
			},
		},
	}

	encoded, err := json.MarshalIndent(reg, "", "  ")
	if err != nil {
		fatalf("marshal registry: %v", err)
	}
	encoded = append(encoded, '\n')
	if err := os.WriteFile(*outPath, encoded, 0o644); err != nil {
		fatalf("write %s: %v", *outPath, err)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
