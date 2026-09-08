import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import type { FilePathWithPrefix, LoadedEntry } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { readContent } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { xxhashNew } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/hash";
import HttpPouch from "pouchdb-adapter-http";
import PouchDB from "pouchdb-core";
import { describe, expect, it } from "vitest";

type FixtureContent = {
    type: "leaf" | "plain" | "newnote";
    data?: string;
    path?: string;
    children?: string[];
    ctime?: number;
    mtime?: number;
    size?: number;
    eden?: Record<string, never>;
    deleted?: boolean;
};

PouchDB.plugin(HttpPouch);

function requiredEnvironment(name: "hostname" | "username" | "password"): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required integration-test environment variable: ${name}`);
    }
    return value;
}

function requireLoaded(entry: false | LoadedEntry): LoadedEntry {
    if (entry === false) {
        throw new Error("Commonlib could not load the fixture entry");
    }
    return entry;
}

describe("external CouchDB document compatibility", () => {
    it("covers the supported untransformed file lifecycle", async () => {
        const databaseName = `livesync-api-compat-${crypto.randomUUID()}`;
        const database = new PouchDB<FixtureContent>(
            `${requiredEnvironment("hostname").replace(/\/+$/u, "")}/${databaseName}`,
            {
                adapter: "http",
                auth: {
                    username: requiredEnvironment("username"),
                    password: requiredEnvironment("password"),
                },
            }
        );
        const xxhash = await xxhashNew();
        let commonlib: DirectFileManipulator | undefined;
        const chunkId = (piece: string) => `h:${xxhash.h64(`${piece}-${piece.length}`).toString(36)}`;
        const readFile = async (id: string): Promise<Uint8Array> => {
            const metadata = await database.get(id);
            const pieces = await Promise.all(
                (metadata.children ?? []).map(async (childId) => {
                    const chunk = await database.get(childId);
                    if (chunk.type !== "leaf" || typeof chunk.data !== "string") {
                        throw new Error(`Invalid Chunk document: ${childId}`);
                    }
                    return chunk.data;
                })
            );
            return metadata.type === "newnote"
                ? Uint8Array.from(pieces.flatMap((piece) => [...Buffer.from(piece, "base64")]))
                : new TextEncoder().encode(pieces.join(""));
        };

        try {
            await database.info();

            const createdAt = Date.now();
            commonlib = new DirectFileManipulator({
                url: requiredEnvironment("hostname").replace(/\/+$/u, ""),
                username: requiredEnvironment("username"),
                password: requiredEnvironment("password"),
                database: databaseName,
                passphrase: undefined,
                obfuscatePassphrase: undefined,
                hashAlg: "xxhash64",
                useEden: false,
                enableCompression: false,
                handleFilenameCaseSensitive: false,
                chunkSplitterVersion: "v3-rabin-karp",
            });
            await commonlib.ready.promise;

            const initialContent = "# café 🌍\n";
            const initialBytes = new TextEncoder().encode(initialContent);
            const initialChunkId = chunkId(initialContent);
            expect(initialChunkId).toMatch(/^h:[0-9a-z]+$/u);
            expect(initialChunkId).not.toBe(`h:${xxhash.h64(initialContent).toString(36)}`);
            const initialChunk = { _id: initialChunkId, type: "leaf" as const, data: initialContent };
            const remoteChunkResult = await database.put(initialChunk);
            expect(remoteChunkResult.rev).toMatch(/^1-[0-9a-f]+$/u);
            const created = await database.put({
                _id: "folder/my note.md",
                path: "Folder/My Note.md",
                type: "plain",
                children: [initialChunkId],
                size: initialBytes.byteLength,
                ctime: createdAt,
                mtime: createdAt,
                eden: {},
            });

            expect(initialBytes.byteLength).toBeGreaterThan(initialContent.length);
            await expect(readFile("folder/my note.md")).resolves.toEqual(initialBytes);
            await expect(database.get("folder/my note.md")).resolves.toMatchObject({
                size: initialBytes.byteLength,
                children: [initialChunkId],
            });
            expect(await commonlib.path2id("Folder/My Note.md" as FilePathWithPrefix)).toBe("folder/my note.md");
            expect(readContent(requireLoaded(await commonlib.get("Folder/My Note.md" as FilePathWithPrefix)))).toBe(
                initialContent
            );

            const binaryPieces = [Uint8Array.from([0, 1]), Uint8Array.from([2, 127, 128, 255])];
            const binaryBytes = Uint8Array.from(binaryPieces.flatMap((piece) => [...piece]));
            const binaryStoredPieces = binaryPieces.map((piece) => Buffer.from(piece).toString("base64"));
            const binaryChunkIds = binaryStoredPieces.map(chunkId);
            await Promise.all(
                binaryStoredPieces.map((data, index) =>
                    database.put({ _id: binaryChunkIds[index], type: "leaf", data })
                )
            );
            await database.put({
                _id: "assets/data.bin",
                path: "Assets/Data.bin",
                type: "newnote",
                children: binaryChunkIds,
                size: binaryBytes.byteLength,
                ctime: createdAt,
                mtime: createdAt,
                eden: {},
            });
            await expect(readFile("assets/data.bin")).resolves.toEqual(binaryBytes);
            const loadedBinary = readContent(
                requireLoaded(await commonlib.get("Assets/Data.bin" as FilePathWithPrefix))
            );
            expect(loadedBinary).toBeInstanceOf(ArrayBuffer);
            expect(new Uint8Array(loadedBinary as ArrayBuffer)).toEqual(binaryBytes);

            const commonlibContent = "Generated through Commonlib.\n";
            const commonlibBytes = new TextEncoder().encode(commonlibContent);
            await expect(
                commonlib.put(
                    "generated.md",
                    [commonlibContent],
                    { ctime: createdAt, mtime: createdAt, size: commonlibBytes.byteLength },
                    "plain"
                )
            ).resolves.toBe(true);
            await expect(database.get("generated.md")).resolves.toMatchObject({
                children: [chunkId(commonlibContent)],
                size: commonlibBytes.byteLength,
            });

            const updatedContent = `${initialContent}\nUpdated externally.\n`;
            const updatedBytes = new TextEncoder().encode(updatedContent);
            const updatedChunkId = chunkId(updatedContent);
            await database.put({ _id: updatedChunkId, type: "leaf", data: updatedContent });
            const current = await database.get("folder/my note.md");
            const updated = await database.put({
                ...current,
                children: [updatedChunkId],
                size: updatedBytes.byteLength,
                mtime: createdAt + 1,
            });
            await expect(readFile("folder/my note.md")).resolves.toEqual(updatedBytes);
            expect(readContent(requireLoaded(await commonlib.get("Folder/My Note.md" as FilePathWithPrefix)))).toBe(
                updatedContent
            );

            await expect(
                database.put({
                    ...current,
                    _rev: created.rev,
                    children: [initialChunkId],
                    mtime: createdAt + 2,
                })
            ).rejects.toMatchObject({ status: 409 });

            const beforeDeletion = await database.get("folder/my note.md");
            await database.put({
                ...beforeDeletion,
                deleted: true,
                mtime: createdAt + 3,
            });
            const deleted = await database.get("folder/my note.md");
            expect(deleted._rev).not.toBe(updated.rev);
            expect(deleted).toMatchObject({
                deleted: true,
                children: [updatedChunkId],
                size: updatedBytes.byteLength,
            });
            await expect(commonlib.get("Folder/My Note.md" as FilePathWithPrefix)).resolves.toBe(false);

            const missingChunkId = chunkId("missing Chunk fixture");
            await database.put({
                _id: "missing.md",
                path: "Missing.md",
                type: "plain",
                children: [missingChunkId],
                size: new TextEncoder().encode("missing Chunk fixture").byteLength,
                ctime: createdAt,
                mtime: createdAt,
                eden: {},
            });
            await expect(database.get("missing.md")).resolves.toMatchObject({ children: [missingChunkId] });
            await expect(readFile("missing.md")).rejects.toMatchObject({ status: 404 });
            await expect(commonlib.get("Missing.md" as FilePathWithPrefix)).resolves.toBe(false);
        } finally {
            await commonlib?.close();
            await database.destroy();
        }
    }, 30_000);
});
