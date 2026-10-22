using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace TheSpot.CandidateClient.Core.Api;

/// <summary>Finds Center Servers on the LAN: broadcasts "THESPOT_DISCOVER_V1" to UDP 41234 and collects JSON replies.</summary>
public static class UdpDiscovery
{
    public const string Probe = "THESPOT_DISCOVER_V1";

    public static async Task<IReadOnlyList<DiscoverInfo>> DiscoverAsync(int port = 41234, TimeSpan? wait = null, CancellationToken ct = default)
    {
        using var udp = new UdpClient(new IPEndPoint(IPAddress.Any, 0)) { EnableBroadcast = true };
        var probe = Encoding.UTF8.GetBytes(Probe);
        foreach (var target in Targets())
        {
            try
            {
                await udp.SendAsync(probe, new IPEndPoint(target, port), ct).ConfigureAwait(false);
            }
            catch (SocketException)
            {
                // an interface may refuse broadcast; try the others
            }
        }
        var found = new Dictionary<string, DiscoverInfo>();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(wait ?? TimeSpan.FromSeconds(2));
        try
        {
            while (true)
            {
                var r = await udp.ReceiveAsync(cts.Token).ConfigureAwait(false);
                var info = Parse(r.Buffer);
                if (info != null) found[$"{info.LanIp}:{info.Port}"] = info;
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // listening window over
        }
        return [.. found.Values];
    }

    internal static DiscoverInfo? Parse(byte[] payload)
    {
        try
        {
            var info = JsonSerializer.Deserialize<DiscoverInfo>(payload, CenterApiClient.Json);
            return info is { Service: "thespot-center" } && info.LanIp.Length > 0 && info.Port > 0 ? info : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static IEnumerable<IPAddress> Targets()
    {
        var set = new HashSet<IPAddress> { IPAddress.Broadcast, IPAddress.Loopback };
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up) continue;
            foreach (var ua in ni.GetIPProperties().UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork || ua.IPv4Mask == null) continue;
                var ip = ua.Address.GetAddressBytes();
                var mask = ua.IPv4Mask.GetAddressBytes();
                var bc = new byte[4];
                for (var i = 0; i < 4; i++) bc[i] = (byte)(ip[i] | ~mask[i]);
                set.Add(new IPAddress(bc));
            }
        }
        return set;
    }
}
