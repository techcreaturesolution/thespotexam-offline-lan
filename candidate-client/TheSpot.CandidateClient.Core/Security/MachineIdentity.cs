using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace TheSpot.CandidateClient.Core.Security;

/// <summary>Stable per-PC id derived from HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (survives app reinstall).</summary>
public static class MachineIdentity
{
    public static string Get()
    {
        var guid = ReadMachineGuid() ?? Environment.MachineName;
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes("thespot-candidate:" + guid.Trim().ToLowerInvariant()));
        return "pc-" + Convert.ToHexString(hash, 0, 16).ToLowerInvariant();
    }

    private static string? ReadMachineGuid()
    {
        try
        {
            using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var k = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
            return k?.GetValue("MachineGuid") as string;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
