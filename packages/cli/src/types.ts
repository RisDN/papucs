export type JsonObject = Record<string, unknown>;
export type RuntimeComposeService = Record<string, unknown>;

export interface BuildSettings {
  dockerfile_template: string;
  image: string;
  tags: string[];
}

export interface ProjectConfig {
  version: 1;
  project: string;
  runtime: {
    dir: string;
  };
  sources: {
    layers: string;
    servers: string;
  };
  compose: {
    file: string;
    shared_server_template: string;
  };
  build: BuildSettings;
  preserve_paths: string[];
  replaceable_text_extensions: string[];
}

export interface ProjectContext {
  root: string;
  configPath: string;
  config: ProjectConfig;
  runtimeRoot: string;
  runtimeComposePath: string;
  runtimeStatePath: string;
  runtimeCacheDir: string;
  runtimeInstancesDir: string;
  runtimeBuildDir: string;
  runtimeLockPath: string;
  composeFilePath: string;
  serversDir: string;
  layersDir: string;
  sharedServerComposeTemplatePath: string;
  dockerfileTemplatePath: string;
  runtimeReplaceScriptPath: string;
  envPath: string;
  composeProjectName: string;
}

export interface ServerBuildConfig {
  image?: string;
  tags?: string[];
}

export interface ServerConfig {
  name: string;
  image: string;
  compose_service: string;
  instance_name: string;
  actions_build?: boolean;
  build?: ServerBuildConfig;
  interpolate_variables?: Record<string, string | number | boolean>;
  layers?: string[];
  [key: string]: unknown;
}

export interface LayerMeta {
  name: string;
}

export interface SourceFile {
  absPath: string;
  relPath: string;
  hash: string;
  source: string;
}

export interface SourceManifest {
  config: ServerConfig;
  files: Map<string, SourceFile>;
  overrides: Array<{ relPath: string; from: string; to: string }>;
}

export interface ComposeDocument {
  services?: Record<string, RuntimeComposeService>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
}

export interface ComposeTemplate {
  appServiceName: string;
  appServiceDefinition: RuntimeComposeService;
  infraServices: Record<string, RuntimeComposeService>;
  topLevelNetworks: Record<string, unknown>;
  topLevelVolumes: Record<string, unknown>;
}

export interface RuntimeInstance {
  id: string;
  serverType: string;
  index: number;
  serverName: string;
  serviceName: string;
  runtimeDataDir: string;
  templateServiceName: string;
  composeService: RuntimeComposeService;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeState {
  version: 1;
  instances: RuntimeInstance[];
}

export interface SyncCacheFileEntry {
  hash: string;
  source: string;
}

export interface SyncCache {
  instanceId: string;
  serverType: string;
  updatedAt: string;
  files: Record<string, SyncCacheFileEntry>;
}

export interface ApplySyncResult {
  changed: string[];
  deleted: string[];
}

export interface BuildImageResult {
  serverType: string;
  localTags: string[];
  pushedTags: string[];
}

export type CheckStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
}

export interface Reporter {
  log(message: string): void;
  warn(message: string): void;
  verbose(message: string): void;
}
