using System.Security.Cryptography;
using System.Text;

namespace TheSpot.CandidateClient.Core.Security;

public sealed class CacheTamperedException(string file, Exception? inner = null)
    : Exception($"Local cache '{Path.GetFileName(file)}' failed integrity check", inner);

/// <summary>
/// Encrypted local files: AES-256-GCM with a random per-PC key that is itself protected with DPAPI (current user).
/// Layout: "TSC1" | nonce(12) | tag(16) | ciphertext. The file's logical name is bound as AAD, so files can't be swapped.
/// Writes are atomic (temp file + flush-to-disk + replace) so a crash mid-write leaves the previous version intact.
/// </summary>
public sealed class SecureStore
{
    private static readonly byte[] Magic = "TSC1"u8.ToArray();
    private static readonly byte[] KeyEntropy = "thespot-candidate-client:cache-key:v1"u8.ToArray();
    private readonly byte[] _key;

    public string Directory { get; }

    public SecureStore(string directory)
    {
        Directory = directory;
        System.IO.Directory.CreateDirectory(directory);
        _key = LoadOrCreateKey(Path.Combine(directory, "cache.key"));
    }

    private static byte[] LoadOrCreateKey(string path)
    {
        if (File.Exists(path)) return Dpapi.Unprotect(File.ReadAllBytes(path), KeyEntropy);
        var key = RandomNumberGenerator.GetBytes(32);
        AtomicWrite(path, Dpapi.Protect(key, KeyEntropy));
        return key;
    }

    public string PathFor(string name) => Path.Combine(Directory, name);

    public byte[] Encrypt(string name, byte[] plaintext)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var tag = new byte[16];
        var ct = new byte[plaintext.Length];
        using (var gcm = new AesGcm(_key, 16)) gcm.Encrypt(nonce, plaintext, ct, tag, Aad(name));
        return [.. Magic, .. nonce, .. tag, .. ct];
    }

    public byte[] Decrypt(string name, byte[] blob)
    {
        if (blob.Length < 32 || !blob.AsSpan(0, 4).SequenceEqual(Magic)) throw new CacheTamperedException(name);
        var nonce = blob.AsSpan(4, 12);
        var tag = blob.AsSpan(16, 16);
        var ct = blob.AsSpan(32);
        var pt = new byte[ct.Length];
        try
        {
            using var gcm = new AesGcm(_key, 16);
            gcm.Decrypt(nonce, ct, tag, pt, Aad(name));
        }
        catch (CryptographicException e)
        {
            throw new CacheTamperedException(name, e);
        }
        return pt;
    }

    public void Write(string name, byte[] plaintext) => AtomicWrite(PathFor(name), Encrypt(name, plaintext));

    public void WriteText(string name, string text) => Write(name, Encoding.UTF8.GetBytes(text));

    /// <summary>Returns null when the file doesn't exist; throws <see cref="CacheTamperedException"/> if it was modified.</summary>
    public string? ReadText(string name)
    {
        var p = PathFor(name);
        if (!File.Exists(p)) return null;
        return Encoding.UTF8.GetString(Decrypt(name, File.ReadAllBytes(p)));
    }

    /// <summary>Moves a corrupt/tampered file aside (kept for the invigilator) so the client can continue.</summary>
    public string Quarantine(string name)
    {
        var p = PathFor(name);
        var q = $"{p}.bad-{DateTime.UtcNow:yyyyMMddHHmmss}";
        if (File.Exists(p)) File.Move(p, q, overwrite: true);
        return q;
    }

    public void Delete(string name)
    {
        var p = PathFor(name);
        if (File.Exists(p)) File.Delete(p);
    }

    private static byte[] Aad(string name) => Encoding.UTF8.GetBytes("thespot-cache:" + name);

    internal static void AtomicWrite(string path, byte[] data)
    {
        var tmp = path + ".tmp";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            fs.Write(data);
            fs.Flush(flushToDisk: true);
        }
        if (File.Exists(path)) File.Replace(tmp, path, null, ignoreMetadataErrors: true);
        else File.Move(tmp, path);
    }
}
