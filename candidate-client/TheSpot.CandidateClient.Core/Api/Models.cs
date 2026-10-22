using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace TheSpot.CandidateClient.Core.Api;

public sealed record DiscoverInfo
{
    public string? Service { get; init; }
    public string? CenterCode { get; init; }
    public string? CenterName { get; init; }
    public string LanIp { get; init; } = "";
    public int Port { get; init; }
    public bool Tls { get; init; } = true;
    public string? CertFingerprint { get; init; }
    public string? ServerTime { get; init; }
    public string? AppVersion { get; init; }
}

public sealed record RegisterResult(string MachineToken);

public sealed record CandidateInfo
{
    public string Id { get; init; } = "";
    public string RollNumber { get; init; } = "";
    public string Name { get; init; } = "";
    public int? SeatNumber { get; init; }
}

public sealed record ExamState
{
    public string ExamId { get; init; } = "";
    /// <summary>locked | unlocked | running | paused | ended …</summary>
    [JsonPropertyName("examState")]
    public string Phase { get; init; } = "";
    public string? Title { get; init; }
    public string? ServerTime { get; init; }
    public int DurationSeconds { get; init; }
    public int RemainingSeconds { get; init; }
    /// <summary>not_started | in_progress | submitted | auto_submitted | force_submitted | disqualified | absent</summary>
    public string? AttemptStatus { get; init; }
    public bool Paused { get; init; }

    public static readonly string[] FinalStatuses = ["submitted", "auto_submitted", "force_submitted", "disqualified", "absent"];
    public bool IsFinal => AttemptStatus != null && FinalStatuses.Contains(AttemptStatus);
    public bool HasStarted => Phase is "running" or "paused" or "ended";
}

public sealed record LoginResult
{
    public string SessionToken { get; init; } = "";
    public string ExamId { get; init; } = "";
    public CandidateInfo Candidate { get; init; } = new();
    public ExamState State { get; init; } = new();
}

public sealed record OptionDto(int Id, string Text);

public sealed record QuestionDto
{
    public string Id { get; init; } = "";
    public string Type { get; init; } = "mcq_single";
    public string Text { get; init; } = "";
    public string? Html { get; init; }
    public double Marks { get; init; }
    public double NegativeMarks { get; init; }
    public List<OptionDto> Options { get; init; } = [];
    public bool IsMultiple => Type is "mcq_multiple" or "multiple" or "msq";
}

public sealed record SectionDto
{
    public int Index { get; init; }
    public string Name { get; init; } = "";
    public string? Description { get; init; }
    public double MarksPerQuestion { get; init; }
    public double NegativeMarks { get; init; }
    public List<QuestionDto> Questions { get; init; } = [];
}

public sealed record ExamInfoDto
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string? Instructions { get; init; }
    public bool AllowReview { get; init; } = true;
}

public sealed record ServerAnswer
{
    public string QuestionId { get; init; } = "";
    public JsonNode? Answer { get; init; }
    public bool Flagged { get; init; }
    public int Version { get; init; }
}

public sealed record QuestionsResult
{
    public ExamInfoDto Exam { get; init; } = new();
    public List<SectionDto> Sections { get; init; } = [];
    public List<ServerAnswer> Answers { get; init; } = [];
    public ExamState State { get; init; } = new();
}

public sealed record AnswerUpload
{
    public string QuestionId { get; init; } = "";
    public JsonNode? Answer { get; init; }
    public bool Flagged { get; init; }
    public int Version { get; init; }
    public int? TimeTakenSeconds { get; init; }
}

public sealed record SaveItemResult(string QuestionId, int Version, string Status);

public sealed record SaveResult
{
    public List<SaveItemResult> Results { get; init; } = [];
    public ExamState State { get; init; } = new();
}

public sealed record SubmitResult
{
    public string Status { get; init; } = "";
    public string? SubmittedAt { get; init; }
    public bool AlreadySubmitted { get; init; }
}

public sealed record ViolationUpload(string Type, string? Detail, string At);
