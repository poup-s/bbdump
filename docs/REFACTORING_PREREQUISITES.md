# Plan de Refactorisation : Gestion des Prérequis par OS

## État des Lieux Actuel

### Problèmes Identifiés

1. **Détection d'OS dispersée**
   - `postgresManager.ts` : fonction `getOS()` locale
   - `main.ts` : utilisation directe de `process.platform`
   - Pas de standardisation

2. **Détection d'outils dupliquée**
   - `main.ts` : fonction `findExecutable()` locale dans `checkPrerequisites()`
   - `backup.ts` : méthode `findPostgresCommand()` avec logique différente
   - `postgresManager.ts` : logique de détection PostgreSQL spécifique
   - Chemins codés en dur dans plusieurs fichiers

3. **Chemins codés en dur**
   - macOS : `/opt/homebrew/bin/`, `/usr/local/bin/` répétés partout
   - Versions PostgreSQL : `@17`, `@16` codées en dur
   - Pas de gestion Linux/Windows préparée

4. **Manque de cohérence**
   - Chaque module a sa propre façon de détecter les outils
   - Pas de source unique de vérité pour les chemins par OS
   - Installation et vérification séparées

### Fichiers Concernés

- `src/main/main.ts` : `checkPrerequisites()`, `installHomebrew()`
- `src/main/postgresManager.ts` : `checkPostgresInstalled()`, `findPostgresDataDir()`, etc.
- `src/main/backup.ts` : `findPostgresCommand()`
- `src/main/databaseCreator.ts` : Utilise directement les outils PostgreSQL

## Architecture Proposée

### Structure des Modules

```
src/main/
├── os/
│   ├── osDetector.ts          # Détection et informations OS
│   └── osPaths.ts             # Chemins standards par OS
├── tools/
│   ├── toolDetector.ts        # Détection d'outils (which + chemins)
│   └── toolInstaller.ts       # Installation d'outils par OS
└── prerequisites/
    └── prerequisitesManager.ts # Orchestration complète
```

### Modules à Créer

#### 1. `osDetector.ts`
**Responsabilité** : Détection centralisée de l'OS et informations système

```typescript
export type OSType = 'macos' | 'linux' | 'windows';
export type Architecture = 'arm64' | 'x64' | 'ia32';

export interface OSInfo {
  type: OSType;
  platform: string; // 'darwin', 'linux', 'win32'
  architecture: Architecture;
  isAppleSilicon: boolean; // Pour macOS uniquement
}

export function detectOS(): OSInfo;
export function isMacOS(): boolean;
export function isLinux(): boolean;
export function isWindows(): boolean;
```

#### 2. `osPaths.ts`
**Responsabilité** : Chemins standards par OS pour chaque outil

```typescript
export interface ToolPaths {
  pgDump: string[];
  psql: string[];
  pgRestore: string[];
  pgConfig: string[];
  initdb: string[];
  postgres: string[];
  brew?: string[]; // macOS uniquement
}

export function getToolPaths(os: OSType, arch?: Architecture): ToolPaths;
export function getPostgresDataDirs(os: OSType, version?: string): string[];
export function getPostgresServiceNames(os: OSType, version?: string): string[];
```

#### 3. `toolDetector.ts`
**Responsabilité** : Détection robuste d'outils (which + chemins standards)

```typescript
export interface ToolDetectionResult {
  installed: boolean;
  path?: string;
  method?: 'which' | 'standard_path' | 'unknown';
  version?: string;
  error?: string;
}

export async function detectTool(
  toolName: string,
  possiblePaths?: string[]
): Promise<ToolDetectionResult>;

export async function detectPostgresTools(): Promise<{
  pgDump: ToolDetectionResult;
  psql: ToolDetectionResult;
  pgRestore: ToolDetectionResult;
  postgres: ToolDetectionResult;
}>;

export async function detectHomebrew(): Promise<ToolDetectionResult>;
```

#### 4. `toolInstaller.ts`
**Responsabilité** : Installation d'outils par OS

```typescript
export interface InstallationProgress {
  step: string;
  message: string;
  progress: number;
}

export async function installHomebrew(
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }>;

export async function installPostgreSQL(
  os: OSType,
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }>;
```

#### 5. `prerequisitesManager.ts`
**Responsabilité** : Orchestration complète de la vérification et installation

```typescript
export interface PrerequisitesResult {
  pgDump: ToolDetectionResult;
  psql: ToolDetectionResult;
  homebrew?: ToolDetectionResult; // macOS uniquement
  postgresServer: {
    installed: boolean;
    version?: string;
    hasServer?: boolean;
    error?: string;
  };
}

export async function checkPrerequisites(): Promise<PrerequisitesResult>;
export async function installMissingPrerequisites(
  prerequisites: PrerequisitesResult,
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; errors?: string[] }>;
```

## Plan d'Implémentation

### Phase 1 : Création des Modules de Base
1. ✅ Créer `osDetector.ts` avec détection OS centralisée
2. ✅ Créer `osPaths.ts` avec chemins standards par OS
3. ✅ Créer `toolDetector.ts` avec détection robuste (which + chemins)
4. ✅ Créer `toolInstaller.ts` avec installation par OS
5. ✅ Créer `prerequisitesManager.ts` pour orchestration

### Phase 2 : Refactorisation
1. ✅ Refactoriser `main.ts` : utiliser `prerequisitesManager`
2. ✅ Refactoriser `backup.ts` : utiliser `toolDetector` au lieu de `findPostgresCommand`
3. ✅ Refactoriser `postgresManager.ts` : utiliser `osDetector` et `toolDetector`
4. ✅ Refactoriser `databaseCreator.ts` : utiliser `toolDetector`

### Phase 3 : Tests et Validation
1. ✅ Tester sur macOS (Apple Silicon et Intel)
2. ✅ Vérifier la cohérence dans toute l'application
3. ✅ S'assurer que l'onboarding fonctionne correctement
4. ✅ Vérifier que les créations de DB fonctionnent après installation

### Phase 4 : Préparation Multi-OS (Future)
1. Ajouter support Linux dans `osPaths.ts`
2. Ajouter support Windows dans `osPaths.ts`
3. Adapter `toolInstaller.ts` pour Linux/Windows
4. Tester sur chaque plateforme

## Principes de Conception

1. **Source Unique de Vérité** : Tous les chemins par OS dans `osPaths.ts`
2. **Détection Robuste** : Toujours essayer `which` d'abord, puis chemins standards
3. **Extensibilité** : Facile d'ajouter Linux/Windows plus tard
4. **Cohérence** : Tous les modules utilisent les mêmes fonctions de détection
5. **Transparence** : Installation automatique et fluide pour l'utilisateur

## Avantages de cette Architecture

- ✅ **Centralisation** : Un seul endroit pour gérer les chemins par OS
- ✅ **Réutilisabilité** : Modules réutilisables dans toute l'application
- ✅ **Maintenabilité** : Facile d'ajouter de nouveaux OS ou outils
- ✅ **Testabilité** : Modules isolés et testables individuellement
- ✅ **Cohérence** : Même logique de détection partout
- ✅ **Extensibilité** : Prêt pour Linux/Windows sans refactoring majeur




