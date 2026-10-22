using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using TheSpot.CandidateClient.Core.Api;

namespace TheSpot.CandidateClient.Tests;

/// <summary>
/// Runs against a live Center Server (`npm run demo` in center-server/, ideally with DEMO_AUTOSTART=1).
/// Host/port from THESPOT_IT_HOST / THESPOT_IT_PORT (default: discovery, then 127.0.0.1:8443). Skipped when unreachable.
/// </summary>
public sealed class LiveServerFactAttribute : FactAttribute
{
    public LiveServerFactAttribute()
    {
        if (Live.Server == null) Skip = "No Center Server reachable (start `npm run demo` in center-server/)";
    }
}

internal static class Live
{
    public static readonly (string host, int port, string fp)? Server = Find();
    public const string Admin = "Admin@12345";
    public const string Roll = "R002";
    public const string Password = "PASS-0002";
    public const string MachineId = "pc-integration-test-0001";

    private static (string, int, string)? Find()
    {
        var host = Environment.GetEnvironmentVariable("THESPOT_IT_HOST");
        var port = int.TryParse(Environment.GetEnvironmentVariable("THESPOT_IT_PORT"), out var p) ? p : 8443;
        if (host == null)
        {
            try
            {
                var d = UdpDiscovery.DiscoverAsync(wait: TimeSpan.FromSeconds(1.5)).Result.FirstOrDefault();
                if (d != null) (host, port) = (d.LanIp, d.Port);
            }
            catch (Exception) { /* fall through */ }
        }
        host ??= "127.0.0.1";
        try
        {
            return (host, port, CenterApiClient.ProbeFingerprintAsync(host, port).Result);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Admin calls over the same pinned channel (reset the test machine/candidate so the test is repeatable).</summary>
    public static async Task<JsonNode?> AdminAsync(HttpMethod m, string path, object? body = null, string? token = null)
    {
        var (host, port, fp) = Server!.Value;
        using var h = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, c, _, _) => c != null && TheSpot.CandidateClient.Core.Security.CertificatePin.Matches(c, fp) };
        using var http = new HttpClient(h) { BaseAddress = new Uri($"https://{host}:{port}") };
        using var req = new HttpRequestMessage(m, path);
        if (token != null) req.Headers.Authorization = new("Bearer", token);
        if (body != null) req.Content = JsonContent.Create(body);
        using var res = await http.SendAsync(req);
        return (await res.Content.ReadFromJsonAsync<JsonNode>())?["data"];
    }
}

public class IntegrationTests
{
    [LiveServerFact]
    public async Task Discovery_reports_the_same_certificate_we_see()
    {
        var (host, port, fp) = Live.Server!.Value;
        using var c = new CenterApiClient(host, port, fp, Live.MachineId);
        var d = await c.DiscoverAsync();
        Assert.Equal("thespot-center", d.Service);
        Assert.Equal(fp, TheSpot.CandidateClient.Core.Security.CertificatePin.Normalize(d.CertFingerprint));
    }

    [LiveServerFact]
    public async Task Wrong_pin_is_refused_without_fallback()
    {
        var (host, port, _) = Live.Server!.Value;
        using var c = new CenterApiClient(host, port, new string('0', 64), Live.MachineId);
        var e = await Assert.ThrowsAsync<PinMismatchException>(() => c.DiscoverAsync());
        Assert.Equal(Live.Server!.Value.fp, e.Presented);
    }

    [LiveServerFact]
    public async Task Register_login_save_versioned_and_log_violation()
    {
        var (host, port, fp) = Live.Server!.Value;
        var admin = (await Live.AdminAsync(HttpMethod.Post, "/admin/login", new { password = Live.Admin }))!["token"]!.GetValue<string>();
        await Live.AdminAsync(HttpMethod.Post, $"/admin/machines/{Live.MachineId}/reset", new { }, admin);
        using var c = new CenterApiClient(host, port, fp, Live.MachineId);
        c.MachineToken = (await c.RegisterAsync("it-host", "test")).MachineToken;
        LoginResult login;
        try
        {
            login = await c.LoginAsync(Live.Roll, Live.Password);
        }
        catch (ApiException e) when (e.Status == HttpStatusCode.Conflict)
        {
            // bound/submitted from an earlier run: reset (and reopen) the candidate, then retry
            await Live.AdminAsync(HttpMethod.Post, "/admin/exams/665f00000000000000000001/reset-candidate", new { rollNumber = Live.Roll, reopen = true }, admin);
            login = await c.LoginAsync(Live.Roll, Live.Password);
        }
        Assert.Equal(Live.Roll, login.Candidate.RollNumber);
        var state = await c.GetStateAsync();
        Assert.Equal(login.ExamId, state.ExamId);
        await c.LogViolationsAsync([new ViolationUpload("integration_test", "from xunit", DateTime.UtcNow.ToString("O"))]);
        if (!state.HasStarted || state.IsFinal) return; // exam not started: nothing more to check

        var q = await c.GetQuestionsAsync();
        Assert.NotEmpty(q.Sections);
        var first = q.Sections[0].Questions[0];
        Assert.DoesNotContain("correct", JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(first))!.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        var v = (q.Answers.FirstOrDefault(a => a.QuestionId == first.Id)?.Version ?? 0) + 1;
        var save = await c.SaveAnswersAsync([new AnswerUpload { QuestionId = first.Id, Answer = JsonValue.Create(first.Options[0].Id), Version = v }]);
        Assert.Equal("saved", save.Results[0].Status);
        var stale = await c.SaveAnswersAsync([new AnswerUpload { QuestionId = first.Id, Answer = JsonValue.Create(first.Options[1].Id), Version = v }]);
        Assert.Equal("stale", stale.Results[0].Status);
        var again = await c.GetQuestionsAsync();
        Assert.Equal(first.Options[0].Id, again.Answers.Single(a => a.QuestionId == first.Id).Answer!.GetValue<int>());
        Assert.InRange(save.State.RemainingSeconds, 1, save.State.DurationSeconds);
    }
}
