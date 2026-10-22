using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace TheSpot.CandidateClient.Core.Security;

/// <summary>SHA-256 certificate fingerprints in the Center Server's format ("AB:CD:…", same as Node's fingerprint256).</summary>
public static class CertificatePin
{
    public static string Normalize(string? fp)
    {
        if (string.IsNullOrWhiteSpace(fp)) return "";
        var hex = new string(fp.Where(Uri.IsHexDigit).ToArray()).ToUpperInvariant();
        return hex.Length == 64 ? string.Join(':', Enumerable.Range(0, 32).Select(i => hex.Substring(i * 2, 2))) : "";
    }

    public static string Of(X509Certificate cert) => Normalize(Convert.ToHexString(SHA256.HashData(cert.GetRawCertData())));

    public static bool Matches(X509Certificate? cert, string pinned)
    {
        var want = Normalize(pinned);
        if (cert == null || want.Length == 0) return false;
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Of(cert)), Encoding.ASCII.GetBytes(want));
    }
}
