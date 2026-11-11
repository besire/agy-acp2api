package plugin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Enabled      bool   `yaml:"enabled" json:"enabled"`
	UpstreamURL  string `yaml:"upstream_url" json:"upstream_url"`
	APIKey       string `yaml:"api_key" json:"api_key"`
	AutoStart    bool   `yaml:"auto_start" json:"auto_start"`
	Agy2ApiEntry string `yaml:"agy2api_entry" json:"agy2api_entry"`
}

func DefaultConfig() Config {
	return Config{
		Enabled:     true,
		UpstreamURL: "http://127.0.0.1:8787",
		APIKey:      "sk-agy2api-local-key",
		AutoStart:   false,
	}
}

type HostCallbackFunc func(method string, payload []byte) ([]byte, error)

type App struct {
	mu           sync.RWMutex
	cfg          Config
	pluginDir    string
	client       *http.Client
	streamClient *http.Client
	hostCall     HostCallbackFunc
	sidecarCmd   *exec.Cmd
	cachedModels map[string]bool
}

func NewApp() *App {
	return &App{
		cfg: DefaultConfig(),
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		streamClient: &http.Client{
			Timeout: 0, // Streaming has no fixed HTTP client timeout
		},
		cachedModels: make(map[string]bool),
	}
}

func (a *App) SetHostCallback(fn HostCallbackFunc) {
	a.mu.Lock()
	a.hostCall = fn
	a.mu.Unlock()
}

func (a *App) HandleMethod(method string, request []byte) ([]byte, error) {
	defer func() {
		if r := recover(); r != nil {
			_ = r
		}
	}()
	return a.handleMethod(method, request)
}

func (a *App) handleMethod(method string, request []byte) ([]byte, error) {
	switch method {
	case MethodPluginRegister, MethodPluginReconfigure:
		if err := a.configure(request); err != nil {
			return nil, err
		}
		return OKEnvelope(a.registration())
	case MethodPluginShutdown:
		a.Shutdown()
		return OKEnvelope(map[string]any{"status": "ok"})
	case MethodExecutorIdentifier:
		return OKEnvelope(IdentifierResponse{Identifier: PluginID})
	case MethodModelRegister, MethodModelStatic, MethodModelForAuth:
		return a.handleModels()
	case MethodModelRoute:
		return a.handleModelRoute(request)
	case MethodExecutorExecute:
		return a.handleExecute(request)
	case MethodExecutorExecuteStream:
		return a.handleExecuteStream(request)
	case MethodExecutorCountTokens:
		return OKEnvelope(ExecutorResponse{
			Payload: []byte(`{"total_tokens":0}`),
			Headers: http.Header{"Content-Type": []string{"application/json"}},
		})
	case MethodManagementRegister:
		return OKEnvelope(a.managementRegistration())
	case MethodManagementHandle:
		return a.handleManagement(request)
	default:
		return ErrorEnvelope("unknown_method", "unknown method: "+method, http.StatusNotFound), nil
	}
}

func (a *App) configure(raw []byte) error {
	var req LifecycleRequest
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &req)
	}
	cfg := DefaultConfig()
	if len(req.ConfigYAML) > 0 {
		_ = yaml.Unmarshal(req.ConfigYAML, &cfg)
	}
	cfg.UpstreamURL = strings.TrimRight(strings.TrimSpace(cfg.UpstreamURL), "/")
	if cfg.UpstreamURL == "" {
		cfg.UpstreamURL = "http://127.0.0.1:8787"
	}

	a.mu.Lock()
	a.cfg = cfg
	if req.PluginDir != "" {
		a.pluginDir = req.PluginDir
	}
	a.mu.Unlock()

	if cfg.Enabled && cfg.AutoStart {
		go a.ensureSidecarRunning()
	}
	return nil
}

func (a *App) ensureSidecarRunning() {
	a.mu.RLock()
	upstream := a.cfg.UpstreamURL
	entry := a.cfg.Agy2ApiEntry
	pluginDir := a.pluginDir
	a.mu.RUnlock()

	// Check health first
	resp, err := a.client.Get(upstream + "/health")
	if err == nil {
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return
		}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sidecarCmd != nil && a.sidecarCmd.Process != nil {
		return
	}

	if entry == "" && pluginDir != "" {
		candidate := filepath.Join(pluginDir, "..", "dist", "index.js")
		if _, errStat := os.Stat(candidate); errStat == nil {
			entry = candidate
		}
	}
	if entry == "" {
		return
	}

	cmd := exec.Command("node", "--no-warnings", entry)
	cmd.Dir = filepath.Dir(filepath.Dir(entry))
	if errStart := cmd.Start(); errStart == nil {
		a.sidecarCmd = cmd
	}
}

func (a *App) Shutdown() {
	a.mu.Lock()
	cmd := a.sidecarCmd
	a.sidecarCmd = nil
	a.mu.Unlock()

	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}
}

func (a *App) registration() Registration {
	return Registration{
		SchemaVersion: SchemaVersion,
		Metadata: Metadata{
			Name:             PluginName,
			Version:          Version,
			Author:           "chengdidididi",
			GitHubRepository: "https://github.com/chengdidididi/agy-acp2api",
			ConfigFields: []ConfigField{
				{
					Name:        "enabled",
					Type:        "boolean",
					Default:     true,
					Description: "启用或禁用 agy-acp2api 桥接插件。",
				},
				{
					Name:        "upstream_url",
					Type:        "string",
					Default:     "http://127.0.0.1:8787",
					Description: "本地 agy-acp2api 服务的 HTTP 地址（默认 http://127.0.0.1:8787）。",
				},
				{
					Name:        "api_key",
					Type:        "string",
					Default:     "sk-agy2api-local-key",
					Description: "调用本地 agy-acp2api /v1 接口所使用的 Bearer API Key。",
				},
				{
					Name:        "auto_start",
					Type:        "boolean",
					Default:     false,
					Description: "当检测到本地 agy-acp2api 未运行时，是否自动拉起 Node 子进程。",
				},
				{
					Name:        "agy2api_entry",
					Type:        "string",
					Default:     "",
					Description: "自动拉起时的 dist/index.js 路径（可选，默认自动探测）。",
				},
			},
		},
		Capabilities: Capabilities{
			ModelRegistrar:        true,
			ModelProvider:         true,
			ModelRouter:           true,
			Executor:              true,
			ExecutorModelScope:    "both",
			ExecutorInputFormats:  []string{"chat-completions", "openai"},
			ExecutorOutputFormats: []string{"chat-completions", "openai"},
			ManagementAPI:         true,
		},
	}
}

func (a *App) managementRegistration() ManagementRegistrationResponse {
	base := "/plugins/" + PluginID
	return ManagementRegistrationResponse{
		Routes: []ManagementRoute{
			{Method: http.MethodGet, Path: base + "/api/admin/overview", Description: "获取 agy-acp2api 概览、进程池与遥测数据"},
			{Method: http.MethodPost, Path: base + "/api/admin/config", Description: "更新并持久化 agy-acp2api 配置"},
			{Method: http.MethodPost, Path: base + "/api/admin/workers/spawn", Description: "手动扩容启动新的 ACP Worker 进程"},
			{Method: http.MethodDelete, Path: base + "/api/admin/workers", Description: "销毁指定的 ACP Worker 进程"},
			{Method: http.MethodPost, Path: base + "/api/admin/sessions/clear-cache", Description: "清空会话前缀哈希缓存"},
			{Method: http.MethodDelete, Path: base + "/api/admin/sessions", Description: "关闭指定的存续 ACP 会话"},
			{Method: http.MethodGet, Path: base + "/health", Description: "检查本地 agy-acp2api 健康状态"},
		},
		Resources: []ResourceRoute{
			{
				Path:        "/index.html",
				Menu:        "AGY ACP 网关",
				Description: "在 CPA 管理中心内直接访问和操作本地 agy-acp2api 控制台。",
			},
			{
				Path:        "/favicon.svg",
				Description: "agy-acp2api 品牌图标资源",
			},
			{
				Path:        "/api/admin/overview",
				Description: "直连模式概览接口转发",
			},
			{
				Path:        "/api/admin/config",
				Description: "直连模式配置接口转发",
			},
			{
				Path:        "/api/admin/workers/spawn",
				Description: "直连模式进程扩容转发",
			},
			{
				Path:        "/api/admin/workers",
				Description: "直连模式进程销毁转发",
			},
			{
				Path:        "/api/admin/sessions/clear-cache",
				Description: "直连模式哈希清理转发",
			},
			{
				Path:        "/api/admin/sessions",
				Description: "直连模式会话关闭转发",
			},
		},
	}
}

func (a *App) handleManagement(raw []byte) ([]byte, error) {
	var req ManagementRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err
	}

	a.mu.RLock()
	upstream := a.cfg.UpstreamURL
	a.mu.RUnlock()

	path := req.Path
	resourcePrefix := "/v0/resource/plugins/" + PluginID
	mgmtPrefix := "/v0/management/plugins/" + PluginID

	var targetPath string
	if strings.HasPrefix(path, resourcePrefix) {
		sub := strings.TrimPrefix(path, resourcePrefix)
		if sub == "" || sub == "/" || sub == "/index.html" || sub == "/dashboard" {
			targetPath = "/"
		} else {
			targetPath = sub
		}
	} else if strings.HasPrefix(path, mgmtPrefix) {
		sub := strings.TrimPrefix(path, mgmtPrefix)
		if sub == "" {
			sub = "/health"
		}
		targetPath = sub
	} else {
		targetPath = path
	}

	method := req.Method
	bodyBytes := req.Body
	if len(req.Query) > 0 {
		if m := strings.TrimSpace(req.Query.Get("_method")); m != "" {
			method = strings.ToUpper(m)
			req.Query.Del("_method")
		}
		if b := req.Query.Get("_body"); b != "" && len(bodyBytes) == 0 {
			bodyBytes = []byte(b)
			req.Query.Del("_body")
		}
	}
	if method == "" {
		method = http.MethodGet
	}

	targetURL := upstream + targetPath
	if len(req.Query) > 0 {
		q := req.Query.Encode()
		if q != "" {
			targetURL += "?" + q
		}
	}

	httpReq, err := http.NewRequest(method, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return OKEnvelope(a.offlineResponse(targetPath, upstream, err))
	}
	for k, vals := range req.Headers {
		if strings.EqualFold(k, "Host") || strings.EqualFold(k, "Content-Length") {
			continue
		}
		for _, v := range vals {
			httpReq.Header.Add(k, v)
		}
	}
	if len(bodyBytes) > 0 && httpReq.Header.Get("Content-Type") == "" {
		httpReq.Header.Set("Content-Type", "application/json")
	}

	resp, err := a.client.Do(httpReq)
	if err != nil {
		return OKEnvelope(a.offlineResponse(targetPath, upstream, err))
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return OKEnvelope(a.offlineResponse(targetPath, upstream, err))
	}

	outHeaders := make(http.Header)
	for k, vals := range resp.Header {
		for _, v := range vals {
			outHeaders.Add(k, v)
		}
	}

	return OKEnvelope(ManagementResponse{
		StatusCode: resp.StatusCode,
		Headers:    outHeaders,
		Body:       body,
	})
}

func (a *App) offlineResponse(targetPath, upstream string, err error) ManagementResponse {
	if targetPath == "/" {
		html := fmt.Sprintf(`<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8" />
<title>agy2api - 未连接</title>
<style>
  body { margin:0; background:#141218; color:#E6E0E9; font:14px/1.6 system-ui, sans-serif; display:grid; place-items:center; min-height:100vh; }
  .card { background:#211F26; border-radius:16px; padding:28px 32px; max-width:480px; box-shadow:0 4px 20px rgba(0,0,0,.35); }
  h2 { margin:0 0 12px; color:#F2B8B5; font-weight:500; }
  code { background:#2B2930; padding:2px 6px; border-radius:6px; font-family:Consolas, monospace; color:#D0BCFF; }
  .btn { display:inline-block; margin-top:16px; padding:10px 24px; border-radius:20px; background:#D0BCFF; color:#381E72; text-decoration:none; font-weight:600; }
</style>
</head>
<body>
  <div class="card">
    <h2>无法连接到本地 agy-acp2api 服务</h2>
    <p>CPA 插件尝试连接上游地址 <code>%s</code> 失败：</p>
    <p><code>%s</code></p>
    <p>请确认已在本地启动 <code>agy-acp2api</code>（例如运行 <code>npm start</code> 或 <code>start.bat</code>），或者在 CPA 插件设置中检查 <code>upstream_url</code> 配置。</p>
    <a class="btn" href="javascript:location.reload()">重新加载</a>
  </div>
</body>
</html>`, upstream, err.Error())
		return ManagementResponse{
			StatusCode: http.StatusServiceUnavailable,
			Headers:    http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
			Body:       []byte(html),
		}
	}

	errPayload, _ := json.Marshal(map[string]any{
		"status":  "error",
		"message": fmt.Sprintf("upstream agy-acp2api (%s) unreachable: %v", upstream, err),
	})
	return ManagementResponse{
		StatusCode: http.StatusBadGateway,
		Headers:    http.Header{"Content-Type": []string{"application/json; charset=utf-8"}},
		Body:       errPayload,
	}
}

func (a *App) handleModels() ([]byte, error) {
	a.mu.RLock()
	upstream := a.cfg.UpstreamURL
	apiKey := a.cfg.APIKey
	a.mu.RUnlock()

	req, err := http.NewRequest(http.MethodGet, upstream+"/v1/models", nil)
	if err != nil {
		return OKEnvelope(ModelResponse{Provider: PluginID, Models: []ModelInfo{}})
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return OKEnvelope(ModelResponse{Provider: PluginID, Models: []ModelInfo{}})
	}
	defer resp.Body.Close()

	var listResp struct {
		Data []struct {
			ID          string `json:"id"`
			Created     int64  `json:"created"`
			OwnedBy     string `json:"owned_by"`
			Description string `json:"description"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return OKEnvelope(ModelResponse{Provider: PluginID, Models: []ModelInfo{}})
	}

	models := make([]ModelInfo, 0, len(listResp.Data))
	newCache := make(map[string]bool, len(listResp.Data))
	for _, m := range listResp.Data {
		if m.ID == "" {
			continue
		}
		newCache[m.ID] = true
		for _, lv := range []string{"low", "medium", "high"} {
			newCache[m.ID+"-"+lv] = true
		}
		models = append(models, ModelInfo{
			ID:                         m.ID,
			Object:                     "model",
			Created:                    m.Created,
			OwnedBy:                    PluginID,
			DisplayName:                m.Description,
			Name:                       m.ID,
			Description:                m.Description,
			SupportedGenerationMethods: []string{"chat"},
			UserDefined:                true,
		})
	}

	a.mu.Lock()
	a.cachedModels = newCache
	a.mu.Unlock()

	return OKEnvelope(ModelResponse{
		Provider: PluginID,
		Models:   models,
	})
}

func stripThinkingSuffix(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return s
	}
	lower := strings.ToLower(s)
	levels := []string{"low", "medium", "high", "minimal", "max", "xhigh"}

	// Bracket syntax: e.g. gemini-4-carbon(high), gemini-4-carbon [low]
	for _, pair := range [][2]string{{"(", ")"}, {"[", "]"}} {
		if strings.HasSuffix(lower, pair[1]) {
			if idx := strings.LastIndex(lower, pair[0]); idx > 0 {
				inner := strings.TrimSpace(lower[idx+1 : len(lower)-1])
				for _, lv := range levels {
					if inner == lv {
						return strings.TrimSpace(s[:idx])
					}
				}
			}
		}
	}

	// Delimiter syntax: e.g. gemini-4-carbon:high, gemini-4-carbon@low, gemini-4-carbon-high
	for _, sep := range []string{":", "@", "/", "-"} {
		if idx := strings.LastIndex(lower, sep); idx > 0 {
			tail := strings.TrimSpace(lower[idx+1:])
			for _, lv := range levels {
				if sep == "-" && lv != "low" && lv != "medium" && lv != "high" {
					continue
				}
				if tail == lv {
					return strings.TrimSpace(s[:idx])
				}
			}
		}
	}
	return s
}

func (a *App) handleModelRoute(raw []byte) ([]byte, error) {
	var req ModelRouteRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err
	}
	model := strings.TrimSpace(req.RequestedModel)
	if model == "" {
		return OKEnvelope(ModelRouteResponse{Handled: false})
	}

	baseModel := stripThinkingSuffix(model)

	a.mu.RLock()
	enabled := a.cfg.Enabled
	known := a.cachedModels[model] || a.cachedModels[baseModel]
	a.mu.RUnlock()

	if !enabled {
		return OKEnvelope(ModelRouteResponse{Handled: false})
	}

	if strings.HasPrefix(model, "agy/") {
		targetModel := strings.TrimPrefix(model, "agy/")
		return OKEnvelope(ModelRouteResponse{
			Handled:     true,
			TargetKind:  "self",
			Target:      PluginID,
			TargetModel: targetModel,
			Reason:      "routed via agy/ prefix to local agy-acp2api",
		})
	}

	if known {
		return OKEnvelope(ModelRouteResponse{
			Handled:     true,
			TargetKind:  "self",
			Target:      PluginID,
			TargetModel: model,
			Reason:      "matched agy-acp2api registered model",
		})
	}

	return OKEnvelope(ModelRouteResponse{Handled: false})
}

func (a *App) handleExecute(raw []byte) ([]byte, error) {
	var req ExecutorRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err
	}

	payload := req.Payload
	if len(payload) == 0 {
		payload = req.OriginalRequest
	}

	a.mu.RLock()
	upstream := a.cfg.UpstreamURL
	apiKey := a.cfg.APIKey
	a.mu.RUnlock()

	httpReq, err := http.NewRequest(http.MethodPost, upstream+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := a.streamClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return ErrorEnvelope("upstream_error", string(body), resp.StatusCode), nil
	}

	outHeaders := make(http.Header)
	for k, vals := range resp.Header {
		for _, v := range vals {
			outHeaders.Add(k, v)
		}
	}

	return OKEnvelope(ExecutorResponse{
		Payload: body,
		Headers: outHeaders,
	})
}

func (a *App) handleExecuteStream(raw []byte) ([]byte, error) {
	var req ExecutorRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err
	}

	payload := req.Payload
	if len(payload) == 0 {
		payload = req.OriginalRequest
	}

	a.mu.RLock()
	upstream := a.cfg.UpstreamURL
	apiKey := a.cfg.APIKey
	hostCall := a.hostCall
	a.mu.RUnlock()

	httpReq, err := http.NewRequestWithContext(context.Background(), http.MethodPost, upstream+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := a.streamClient.Do(httpReq)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return ErrorEnvelope("upstream_error", string(body), resp.StatusCode), nil
	}

	outHeaders := http.Header{
		"Content-Type":  []string{"text/event-stream; charset=utf-8"},
		"Cache-Control": []string{"no-cache"},
	}

	// If CPA provides a StreamID and host callback, stream chunks asynchronously via host.stream.emit
	if req.StreamID != "" && hostCall != nil {
		go a.pumpStreamToHost(req.StreamID, resp.Body, hostCall)
		return OKEnvelope(ExecutorStreamResponse{
			Headers: outHeaders,
		})
	}

	// Fallback: collect chunks if StreamID is not used
	defer resp.Body.Close()
	var chunks []ExecutorStreamChunk
	reader := bufio.NewReader(resp.Body)
	for {
		line, errRead := reader.ReadBytes('\n')
		if len(line) > 0 {
			chunks = append(chunks, ExecutorStreamChunk{Payload: append([]byte(nil), line...)})
		}
		if errRead != nil {
			if errors.Is(errRead, io.EOF) {
				break
			}
			return nil, errRead
		}
	}

	return OKEnvelope(ExecutorStreamResponse{
		Headers: outHeaders,
		Chunks:  chunks,
	})
}

func (a *App) pumpStreamToHost(streamID string, body io.ReadCloser, hostCall HostCallbackFunc) {
	defer body.Close()
	errMsg := ""
	defer func() {
		closePayload, _ := json.Marshal(HostStreamCloseRequest{
			StreamID: streamID,
			Error:    errMsg,
		})
		_, _ = hostCall(MethodHostStreamClose, closePayload)
	}()

	buf := make([]byte, 4096)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			emitPayload, _ := json.Marshal(HostStreamEmitRequest{
				StreamID: streamID,
				Payload:  append([]byte(nil), buf[:n]...),
			})
			if _, errEmit := hostCall(MethodHostStreamEmit, emitPayload); errEmit != nil {
				errMsg = errEmit.Error()
				return
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				errMsg = err.Error()
			}
			return
		}
	}
}
