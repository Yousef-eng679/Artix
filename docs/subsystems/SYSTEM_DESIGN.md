# System Architect Canvas Subsystem

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/components/SystemArchitect/`, `src/hooks/useSystemDesigns.tsx`, `src/lib/repositories/systemDesignRepository.ts`

---

## 1. Overview

The **System Architect** is an interactive visual canvas built inside Artix for blueprinting cloud architectures, microservice graphs, distributed event flows, and database topologies. 

Architectural designs are saved as first-class workspace entities, synchronized locally via IndexedDB (`ArtixDB.system_designs`) and replicated to Supabase PostgreSQL with CAS version protection.

---

## 2. Canvas Engine Architecture

Powered by React Flow (`@xyflow/react`):

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SystemArchitect Canvas                             │
├────────────────────────────┬────────────────────────────────────────────────┤
│ Component Library Sidebar  │ Interactive Node-Graph Canvas                  │
│                            │                                                │
│  [+ API Gateway]           │  ┌──────────────┐       ┌──────────────┐       │
│  [+ Microservice]          │  │ API Gateway  ├──────►│ Microservice │       │
│  [+ PostgreSQL DB]         │  └──────────────┘       └──────┬───────┘       │
│  [+ Redis Cache]           │                                │               │
│  [+ RabbitMQ Bus]          │                                ▼               │
│  [+ Storage Bucket]        │                         ┌──────────────┐       │
│                            │                         │ PostgreSQL   │       │
│                            │                         └──────────────┘       │
├────────────────────────────┴────────────────────────────────────────────────┤
│ Canvas Controls: MiniMap | Zoom Slider | Export (PNG/SVG/JSON) | Auto-Save  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Specialized Architectural Node Types

Defined in `src/components/SystemArchitect/nodes/`:

| Node Type | Icon & Visual Styling | Standard Use Case | Configurable Attributes |
|---|---|---|---|
| **API Gateway** | Purple gradient border, routing icon | Public reverse proxies, ingress, rate limiters (Kong, Nginx, AWS API GW) | Port, protocol (HTTP/2, gRPC), rate limit |
| **Microservice** | Blue gradient border, container icon | Stateless application services, backend workers, Lambda functions | Tech stack (Go, Node, Rust), memory, scaling |
| **PostgreSQL DB** | Emerald border, database cylinder | Relational storage, primary-replica clusters, read replicas | Engine, pool size, version |
| **Redis Cache** | Amber border, memory lightning icon | In-memory key-value caches, session stores, Pub/Sub | TTL, eviction policy, cluster mode |
| **Message Queue**| Coral border, queue stack icon | Event brokers, message buses (Kafka, RabbitMQ, SQS) | Topic/queue name, partition count |
| **Cloud Storage**| Sky blue border, bucket icon | Object storage, static assets (S3, Cloudflare R2) | Bucket name, CDN distribution |

---

## 4. Canvas State Model (`BoardState`)

The state of a system design canvas is serialized as a JSON object:

```typescript
export interface BoardState {
  nodes: CustomNode[];
  edges: CustomEdge[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  gridSnap?: boolean;
}

export interface CustomNode {
  id: string;
  type: string; // 'apiGateway' | 'microservice' | 'database' | 'cache' | 'queue'
  position: { x: number; y: number };
  data: {
    label: string;
    description?: string;
    techStack?: string;
    metrics?: Record<string, any>;
  };
}

export interface CustomEdge {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
  style?: Record<string, any>;
  label?: string;
}
```

---

## 5. Resilient Auto-Save Pipeline

When nodes or edges are moved, added, or modified:
1. `SystemArchitect.tsx` buffers modifications in local React state.
2. A debounced timer (750ms) triggers `updateDesign(designId, { boardState })`.
3. `SystemDesignRepository` executes an atomic 3-table Dexie transaction, saving the `boardState`, incrementing `localRevision`, and enqueuing an outbox mutation.
4. If the user closes the tab immediately, `tabCloseGuard.ts` flushes any pending dirty states to disk.

---

## 6. Diagram Export Subsystem

Managed by `src/components/SystemArchitect/ExportDiagramDialog.tsx`:
- **High-Resolution PNG**: Renders the canvas DOM element to an offscreen HTML5 canvas using `html-to-image` at 2x pixel ratio for retina documentation.
- **Scalable Vector Graphics (SVG)**: Exports clean vector paths suitable for embedding in GitHub READMEs.
- **Structured JSON Blueprint**: Exports the raw `boardState` for version control or importing into other Artix workspaces.
