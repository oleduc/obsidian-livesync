---
date: 2026-09-07
commonlib-version: "0.1.23"
self-hosted-livesync-version: "1.0.27"
status: experimental
---

# CouchDB Interoperability Guide for Self-hosted LiveSync

Self-hosted LiveSync does not currently provide a stable SDK or external
integration API. Direct CouchDB access is nevertheless the only practical
integration method for some external tools, particularly software which cannot
run the JavaScript Commonlib package.

This document describes the observed database representation and the raw CRUD
operations tested for the versions and configuration declared below. It is an
interoperability guide, not a stable API contract. External tools must pin their
assumptions to specific Self-hosted LiveSync and Commonlib versions and should
expect the representation to change between releases.

## Authority and Commonlib

The executable authority for document types, path and identifier encoding,
Chunk splitting and hashing, compression, E2EE, and content reconstruction is
the exact [`@vrtmrz/livesync-commonlib`](https://www.npmjs.com/package/@vrtmrz/livesync-commonlib)
version used by the target Self-hosted LiveSync release. JavaScript and
TypeScript integrations should use that package where practical.

Commonlib is a public, pre-1.0 npm package, but it is not yet a stable external
SDK. Its root and task-oriented exports are preferable to `compat/*` exports,
which exist primarily to support the package migration and may change. The
[package-boundary decision](adr/2026_07_common_library_package_boundary.md)
tracks the future high-level client API.

The maintained [Database Data Structures](datastructure.md) document is the
project-owned overview. If it, this guide, and the installed Commonlib package
differ, Commonlib is authoritative for that release and the documentation
should be corrected.

## Representation Boundaries

Three representations must not be conflated:

1. decoded file data and Metadata used by Commonlib services;
2. local PouchDB documents, including CouchDB revision fields; and
3. raw remote CouchDB documents after compression, E2EE, or path obfuscation.

The tested examples in this guide deliberately disable all transforms, making
the local and raw remote document bodies equivalent apart from CouchDB-managed
fields. The [Transformed Representations](#transformed-representations) section
describes why that assumption does not hold for other configurations.

## Support Matrix

The executable fixture establishes the following narrow direct-access contract
against both CouchDB and Commonlib's `DirectFileManipulator`:

| Dimension                                   | Tested value                                         |
| ------------------------------------------- | ---------------------------------------------------- |
| Self-hosted LiveSync                        | `1.0.27`                                             |
| Commonlib                                   | `0.1.23`                                             |
| CouchDB                                     | `3.5.0`, single Node                                 |
| Remote type                                 | CouchDB                                              |
| File types                                  | ordinary text (`plain`) and binary (`newnote`) files |
| `hashAlg`                                   | `xxhash64`                                           |
| `handleFilenameCaseSensitive`               | `false`                                              |
| `encrypt`                                   | `false`                                              |
| `enableCompression`                         | `false`                                              |
| `usePathObfuscation`                        | `false`                                              |
| `useEden`                                   | `false`                                              |
| `deleteMetadataOfDeletedFiles`              | `false`                                              |
| `automaticallyDeleteMetadataOfDeletedFiles` | `0`                                                  |

The fixture covers create, read and reconstruction, update, logical deletion,
Unicode byte sizes, stale revisions, missing Chunks, and binary data. Run it
against the repository CouchDB fixture with:

```bash
$ npm run test:docker-couchdb:start
$ npm run test:compatibility:couchdb
$ npm run test:docker-couchdb:stop
```

The following combinations are outside the tested direct-write contract:

| Combination                                       | Status                                                     |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `handleFilenameCaseSensitive: true`               | Format described, but not covered by the fixture           |
| Data Compression                                  | Format described; direct writes are not covered            |
| E2EE V1 or V2                                     | Commonlib required; direct writes are not supported here   |
| Path or property obfuscation                      | Commonlib required; direct writes are not supported here   |
| Eden Chunks                                       | Compatibility-only; direct writes are not supported here   |
| Hidden File Sync and Customisation Sync           | Namespace described; payload and direct writes unsupported |
| legacy `notes` Metadata or legacy hash algorithms | Read compatibility only                                    |
| Object Storage and P2P remotes                    | Not CouchDB representations and outside scope              |

A combination being outside the tested contract does not mean that Self-hosted
LiveSync itself does not support it. It means that this guide does not promise
that manually constructed raw documents will interoperate with it.

## File Storage Model

An ordinary current file consists of:

- one Metadata document containing the path, timestamps, decoded byte size,
  deletion state, and ordered Chunk references; and
- zero or more immutable, content-addressed Chunk documents containing the file
  data.

The Metadata document never stores current raw file content directly. An empty
file has no Chunks. Text Chunks contain literal text. Each binary Chunk contains
the canonical Base64 representation of that Chunk's decoded bytes. A reader
decodes each binary Chunk separately, then concatenates the decoded bytes in
`children` order. Concatenating padded Base64 strings before decoding can
truncate the file.

A writer should create every referenced Chunk before updating the Metadata.
These writes are not one atomic CouchDB transaction, so readers must still cope
with temporarily or permanently missing Chunks. The current client behaviour is
defined in [Chunk Retrieval and Waiting](design_docs/chunk_retrieval_and_waiting.md).

## Document Types and Namespaces

The principal file-related persisted types are:

| `type`         | Meaning                            | Current writer                       |
| -------------- | ---------------------------------- | ------------------------------------ |
| `plain`        | chunked text Metadata              | yes                                  |
| `newnote`      | chunked binary Metadata            | yes                                  |
| `leaf`         | a content Chunk                    | yes                                  |
| `notes`        | legacy Metadata with inline `data` | no                                   |
| `internalfile` | retained compatibility type        | no current Hidden File Sync producer |

`plain` and `newnote` distinguish text from binary data. They do not mean
'legacy' and 'current'. The legacy `notes` type is not safe for new external
writes because not every current replication path accepts newly created legacy
documents.

Prefixes select namespaces or representations; they do not generally select a
document `type`:

| Prefix | Meaning                                                 |
| ------ | ------------------------------------------------------- |
| none   | ordinary Vault file Metadata                            |
| `i:`   | Hidden File Sync Metadata                               |
| `ix:`  | Customisation Sync Metadata                             |
| `ps:`  | compatibility namespace for plug-in storage data        |
| `f:`   | obfuscated document-ID body                             |
| `h:`   | Chunk document                                          |
| `h:+`  | Chunk identifier incorporating E2EE passphrase material |

Current Hidden File Sync and Customisation Sync writers store ordinary chunked
`plain` or `newnote` Metadata under `i:` and `ix:`. The application-local
`type: "plugin"` interface is not the current Customisation Sync database
format.

## Paths and Metadata IDs

Commonlib's path service derives `_id` from the logical `path`. For the tested
case-insensitive configuration:

```text
_id = lowerCase(normalisePath(path))
```

Path separators are `/`, and an ordinary path has no leading slash. The `path`
property retains its logical case:

```json
{
    "_id": "folder/my note.md",
    "path": "Folder/My Note.md"
}
```

There are three important variations:

- with `handleFilenameCaseSensitive: true`, Commonlib does not fold the path to
  lower case;
- a path beginning with `_` receives a leading `/` in its document ID because
  CouchDB reserves identifiers beginning with `_`; and
- path obfuscation replaces the identifier body with an `f:` SHA-256-derived
  value while retaining a feature prefix, such as `i:f:` for Hidden File Sync.

External writers must derive identifiers using the target database's exact
case-handling and obfuscation settings. An uppercase identifier is not
intrinsically invalid.

## Metadata Documents

An untransformed text Metadata document has this shape:

```json
{
    "_id": "folder/my note.md",
    "path": "Folder/My Note.md",
    "type": "plain",
    "children": ["h:<base36-xxhash64>"],
    "size": 13,
    "mtime": 1788796800000,
    "ctime": 1788796800000,
    "eden": {}
}
```

The fields are:

| Field        | Type                 | Requirement                                                      |
| ------------ | -------------------- | ---------------------------------------------------------------- |
| `_id`        | string               | Commonlib-derived document identifier                            |
| `_rev`       | string               | CouchDB-managed; required when updating an existing document     |
| `path`       | string               | logical file path, including a feature namespace when applicable |
| `type`       | `plain` or `newnote` | text or binary content                                           |
| `children`   | string array         | Chunk IDs in reconstruction order                                |
| `size`       | number               | decoded file byte length                                         |
| `mtime`      | number               | modification time in Unix epoch milliseconds                     |
| `ctime`      | number               | creation time in Unix epoch milliseconds                         |
| `eden`       | object               | compatibility field; use `{}` in the tested configuration        |
| `deleted`    | boolean              | logical file deletion when `true`                                |
| `_deleted`   | boolean              | CouchDB tombstone, distinct from logical deletion                |
| `_conflicts` | string array         | returned conflict metadata; not an application field to write    |

`datatype` can appear in Commonlib's loaded and saving representations, but the
current Metadata writer does not persist it. External writers should omit it.

### Byte Size

`size` is the byte length of the decoded file, not JavaScript `String.length`.
For text in JavaScript:

```js
const size = new TextEncoder().encode(content).byteLength;
```

For binary files, use the decoded byte array length, not the length of its
Base64 representation. For example, `"café 🌍\n"` has a different UTF-8 byte
length and JavaScript UTF-16 code-unit length. Incorrect sizes can trigger file
integrity warnings and prevent reflection unless the user enables a recovery
setting.

## Chunk Documents

An untransformed Chunk has this shape:

```json
{
    "_id": "h:<base36-xxhash64>",
    "type": "leaf",
    "data": "# café 🌍\n"
}
```

For a `plain` parent, `data` is literal text. For a `newnote` parent, it is the
canonical Base64 representation of that Chunk's decoded bytes. Chunk IDs are
derived from that exact stored piece before optional remote transforms are
applied.

Chunks are content-addressed. A content change creates a new Chunk ID rather
than updating the existing Chunk. Current Chunk revisions are content-derived;
the obsolete `doNotUseFixedRevisionForChunks` setting does not select a current
alternative revision strategy. CouchDB and PouchDB can derive different
generation-one revision hashes for the same body, so external writers should
let the target CouchDB assign `_rev` unless they are implementing the complete
CouchDB replication protocol. Do not manufacture a revision identifier for an
ordinary CRUD write.

### Current `xxhash64` Identifier

For Commonlib `0.1.23` with E2EE disabled, the exact calculation is:

```js
const hashInput = `${piece}-${piece.length}`;
const hash = xxhash.h64(hashInput).toString(36);
const chunkId = `h:${hash}`;
```

Important details:

- `piece.length` is JavaScript's UTF-16 code-unit length;
- xxHash64 uses its default zero seed;
- the unsigned 64-bit result is encoded in lower-case base 36, not hexadecimal;
- `piece` is literal text for a text Chunk and Base64 text for a binary Chunk;
  and
- the Metadata `size` calculation remains decoded byte length and is therefore
  intentionally different from the length used in the hash input.

Use Commonlib's `xxhashNew` export rather than substituting another xxHash
implementation without a compatibility test. Historical algorithms remain
readable through compatibility settings, but this guide does not define them as
supported external-write formats.

### Chunk Boundaries

Commonlib owns the current Chunk splitter and its versioned algorithms. Readers
must not infer boundaries; they concatenate `children` in order. External
writers should use the matching Commonlib splitter where possible. The
compatibility fixture uses manually selected boundaries for small files and
does not claim compatibility for arbitrary large-file splitting strategies or
CouchDB document size limits.

## Create, Read, and Update

For each create or update:

1. Split the decoded file using the supported strategy.
2. Retain each text piece as literal text; encode each binary piece separately
   as canonical Base64.
3. Calculate each Chunk ID from the exact stored text or Base64 piece.
4. Create every missing `leaf` document.
5. Calculate Metadata `size` from the decoded file bytes.
6. Create or update Metadata with the ordered Chunk IDs.

An update must first fetch the current Metadata and submit its current `_rev`.
An ordinary CouchDB `PUT` with a stale `_rev` returns `409 Conflict`; it does
not normally create a conflict branch. Replication-style writes using explicit
revision trees can create branches, but they are outside this CRUD guide.

Modification time does not prove revision identity or make a text revision
authoritative. Conflict and Vault-reflection decisions use CouchDB ancestry,
available content, and device-local provenance. See [Conflict resolution and
revision provenance](specs_conflict_resolution.md).

## Logical Deletion and Tombstones

Logical deletion is a normal successor revision of the existing Metadata:

```json
{
    "_id": "folder/my note.md",
    "_rev": "2-current-revision",
    "path": "Folder/My Note.md",
    "type": "plain",
    "children": ["h:<base36-xxhash64>"],
    "size": 13,
    "mtime": 1788796801000,
    "ctime": 1788796800000,
    "eden": {},
    "deleted": true
}
```

Fetch the latest Metadata, preserve its fields and Chunk references, set
`deleted: true`, and update `mtime`. Do not clear `children` or set `size` to
zero. Retaining these fields allows the deletion to participate in conflict and
revision history.

`_deleted: true` is a CouchDB tombstone. The deleted revision does not retain
the application body, and the tombstone continues to participate in CouchDB
replication. It is not interchangeable with LiveSync logical deletion. Whether
LiveSync immediately tombstones Metadata, or later cleans up retained logical
deletions, depends on `deleteMetadataOfDeletedFiles` and
`automaticallyDeleteMetadataOfDeletedFiles`.

## Missing Chunks

CouchDB accepts Metadata which references a nonexistent Chunk because there is
no cross-document foreign-key constraint. Such Metadata cannot be reconstructed
until every referenced Chunk becomes available.

Current LiveSync does not use the historical fixed 5-second or 30-second values
as ordinary arrival budgets. It waits only while an observable finite
replication or per-identifier CouchDB fetch can still deliver the Chunk, then
performs an authoritative local recheck. A five-minute inactivity fuse bounds a
stalled on-demand claim; it is not evidence that the Chunk is absent.

External writers should still create Chunks first. If a Chunk is genuinely
missing from every source, the user must recreate it from a device which has the
file, restore it from a backup, or explicitly discard the unreadable revision.

## Transformed Representations

The following descriptions aid inspection and diagnosis. They are not a direct
write contract. Use the exact Commonlib version for these configurations.

### Data Compression

With `enableCompression: true`, the CouchDB transform may replace a Chunk's
`data` with a marker followed by Base64-encoded raw-DEFLATE data. Compression is
kept only when the complete transformed string is shorter. Compressed and
uncompressed Chunks can therefore coexist. Metadata is normally unaffected
because current Metadata has no `data` field.

Compression is applied before E2EE V2 encryption, so an encrypted raw value
does not expose the compression marker. See [Data Compression](specs_data_compression.md)
for the maintained contract.

### E2EE

E2EE changes both the Chunk identifier and raw Chunk body. An encrypted Chunk
uses `h:+`, includes passphrase-derived material in its content hash, stores an
encrypted `data` value, and carries representation markers used by Commonlib.
The identifier is not a hash of the resulting ciphertext: Commonlib hashes the
untransformed piece together with passphrase-derived material, then encrypts the
remote body.

E2EE V1 and V2 have different raw markers and key derivation. Reimplementing
them from this description would be unsafe and brittle. Bind Commonlib instead.

### Path and Property Obfuscation

Path obfuscation replaces the document-ID body with an `f:` SHA-256-derived
value. With E2EE V2 property protection, raw Metadata can also move the logical
path, timestamps, size, and `children` into an encrypted payload while exposing
placeholder values in the ordinary fields. Reading the visible remote
`children` array is therefore insufficient to reconstruct the file.

The decoded `path` does not itself become `f:{value}`. Obfuscation is a remote
representation transform around the decoded Metadata.

## Control Documents

External tools should not create or modify LiveSync control documents:

| Document                           | Identifier                                 | Purpose                                                                  |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| version information                | `obsydian_livesync_version`                | internal database compatibility version                                  |
| synchronisation information        | `syncinfo`                                 | CouchDB rebuild-related state                                            |
| CouchDB synchronisation parameters | `_local/obsidian_livesync_sync_parameters` | protocol and E2EE negotiation data                                       |
| Milestone information              | `_local/obsydian_livesync_milestone`       | accepted Nodes, locking, clean-up state, Chunk ranges, and shared tweaks |
| Node information                   | `_local/obsydian_livesync_nodeinfo`        | local Node identity and compatibility markers                            |

The historical spelling `obsydian` is intentional. CouchDB `_local/` documents
do not replicate like ordinary Metadata and Chunks. Changing control documents
can stop synchronisation or make clients use incompatible format settings.

## External Writer Checklist

- Pin Self-hosted LiveSync and Commonlib compatibility versions.
- Verify every format-affecting setting before writing.
- Use Commonlib where the runtime permits it.
- Derive Metadata IDs with the configured Commonlib path rules.
- Generate current base-36, length-qualified Chunk IDs.
- Store decoded byte length in Metadata `size`.
- Write all Chunks before their Metadata.
- Fetch the latest `_rev` immediately before an update.
- Preserve Metadata and Chunk references during logical deletion.
- Treat `409` as a concurrent update, then refetch and reconsider the change.
- Never modify control documents to bypass compatibility checks or locks.
- Back up the database before deploying a new external writer.

## Executable Fixture

[`src/common/couchdbApiCompatibility.integration.spec.ts`](../src/common/couchdbApiCompatibility.integration.spec.ts)
is the executable companion to this guide. It talks directly to CouchDB using
the same untransformed JSON shapes shown here and obtains xxHash64 through the
locked Commonlib package. It also inspects a Commonlib-generated file to verify
the documented Chunk identifier calculation.

The fixture proves that CouchDB accepts and returns the documented shapes,
enforces stale-revision rejection, retains logical deletion as application
data, stores Unicode byte sizes, and exposes missing Chunk references as
missing documents. It also verifies that the pinned Commonlib derives the
document ID, reconstructs the text and binary files, observes updates and
logical deletion, and rejects Metadata whose Chunk is absent. It does not
replace real-Obsidian tests for Vault reflection, conflict resolution,
Chunk-delivery scheduling, transforms, or large-file splitting.

When extending the support matrix, extend the fixture first. A format should
not be labelled 'tested' merely because a manually constructed document was
accepted once by CouchDB.
