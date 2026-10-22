using System.Text;
using TheSpot.CandidateClient.Core.Kiosk;
using TheSpot.CandidateClient.Core.Security;

namespace TheSpot.CandidateClient.Tests;

public class SecurityTests
{
    [Fact]
    public void Dpapi_round_trip_and_entropy_bound()
    {
        var data = Encoding.UTF8.GetBytes("machine-token-123");
        var p = Dpapi.Protect(data, "e1"u8.ToArray());
        Assert.NotEqual(data, p);
        Assert.Equal(data, Dpapi.Unprotect(p, "e1"u8.ToArray()));
        Assert.ThrowsAny<Exception>(() => Dpapi.Unprotect(p, "e2"u8.ToArray()));
    }

    [Fact]
    public void Cache_encryption_round_trip_and_ciphertext_hides_plaintext()
    {
        using var t = new TempDir();
        var s = t.Store();
        s.WriteText("a.bin", "{\"answer\":\"secret-answer\"}");
        var raw = File.ReadAllBytes(s.PathFor("a.bin"));
        Assert.DoesNotContain("secret-answer", Encoding.UTF8.GetString(raw));
        Assert.Equal("{\"answer\":\"secret-answer\"}", s.ReadText("a.bin"));
        // a new SecureStore on the same folder unwraps the same DPAPI-protected key
        Assert.Equal("{\"answer\":\"secret-answer\"}", new SecureStore(t.Path).ReadText("a.bin"));
    }

    [Fact]
    public void Cache_rejects_tampering_truncation_and_file_swaps()
    {
        using var t = new TempDir();
        var s = t.Store();
        s.WriteText("a.bin", "hello world, this is the cache");
        s.WriteText("b.bin", "other file");
        var p = s.PathFor("a.bin");
        var raw = File.ReadAllBytes(p);
        raw[^3] ^= 0x01;
        File.WriteAllBytes(p, raw);
        Assert.Throws<CacheTamperedException>(() => s.ReadText("a.bin"));
        File.WriteAllBytes(p, raw[..20]);
        Assert.Throws<CacheTamperedException>(() => s.ReadText("a.bin"));
        File.Copy(s.PathFor("b.bin"), p, true); // valid ciphertext, wrong file (AAD-bound)
        Assert.Throws<CacheTamperedException>(() => s.ReadText("a.bin"));
        var q = s.Quarantine("a.bin");
        Assert.True(File.Exists(q));
        Assert.Null(s.ReadText("a.bin"));
    }

    [Fact]
    public void Password_hash_verifies_and_never_stores_plaintext()
    {
        var h = PasswordHasher.Hash("Invigilator@123", 20_000);
        Assert.DoesNotContain("Invigilator@123", h);
        Assert.True(PasswordHasher.Verify("Invigilator@123", h));
        Assert.False(PasswordHasher.Verify("wrong", h));
        Assert.False(PasswordHasher.Verify("Invigilator@123", null));
        Assert.False(PasswordHasher.Verify("Invigilator@123", "plain-text"));
    }

    [Fact]
    public void Fingerprints_normalize_to_node_format()
    {
        var hex = new string('a', 64);
        var n = CertificatePin.Normalize(hex);
        Assert.Equal(95, n.Length);
        Assert.StartsWith("AA:AA", n);
        Assert.Equal(n, CertificatePin.Normalize(n.ToLowerInvariant()));
        Assert.Equal("", CertificatePin.Normalize("abc"));
    }

    [Theory]
    [InlineData(KeyPolicy.VK_TAB, true, false, false, "alt_tab")]
    [InlineData(KeyPolicy.VK_LWIN, false, false, false, "win_key")]
    [InlineData(KeyPolicy.VK_RWIN, false, false, false, "win_key")]
    [InlineData(KeyPolicy.VK_F4, true, false, false, "alt_f4")]
    [InlineData(KeyPolicy.VK_ESCAPE, true, false, false, "alt_esc")]
    [InlineData(KeyPolicy.VK_ESCAPE, false, true, false, "ctrl_esc")]
    [InlineData(KeyPolicy.VK_ESCAPE, false, true, true, "ctrl_shift_esc")]
    [InlineData(KeyPolicy.VK_SNAPSHOT, false, false, false, "print_screen")]
    [InlineData(KeyPolicy.VK_C, false, true, false, "copy")]
    [InlineData(KeyPolicy.VK_V, false, true, false, "paste")]
    [InlineData(KeyPolicy.VK_X, false, true, false, "cut")]
    [InlineData(KeyPolicy.VK_INSERT, false, false, true, "paste")]
    public void Kiosk_blocks_escape_and_capture_keys(int vk, bool alt, bool ctrl, bool shift, string violation)
    {
        Assert.Equal(KeyDecision.Block, KeyPolicy.Evaluate(vk, alt, ctrl, shift, out var v));
        Assert.Equal(violation, v);
    }

    [Fact]
    public void Kiosk_allows_typing_and_has_hidden_exit_combo()
    {
        Assert.Equal(KeyDecision.Allow, KeyPolicy.Evaluate(0x41, false, false, true, out _));
        Assert.Equal(KeyDecision.Allow, KeyPolicy.Evaluate(KeyPolicy.VK_TAB, false, false, false, out _));
        Assert.Equal(KeyDecision.InvigilatorExit, KeyPolicy.Evaluate(KeyPolicy.VK_F12, true, true, true, out _));
    }
}
