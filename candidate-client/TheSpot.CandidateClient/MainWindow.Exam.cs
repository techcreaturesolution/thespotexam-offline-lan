using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using TheSpot.CandidateClient.Core.Api;
using TheSpot.CandidateClient.Core.Storage;
using TheSpot.CandidateClient.Core.Sync;

namespace TheSpot.CandidateClient;

public partial class MainWindow
{
    private readonly DispatcherTimer _uiTimer = new() { Interval = TimeSpan.FromMilliseconds(250) };
    private readonly Stopwatch _onQuestion = new();
    private readonly List<(SectionDto Section, QuestionDto Q, int No)> _flat = [];
    private readonly List<Button> _palette = [];
    private readonly List<(Button Button, int First)> _sectionButtons = [];
    private int _current = -1;
    private bool _rendering;

    private void StartExam(CenterApiClient api, LoginResult r)
    {
        var data = _cache.Load(r.ExamId, r.Candidate.RollNumber, out var warning)
                   ?? new ExamCacheData { ExamId = r.ExamId, RollNumber = r.Candidate.RollNumber };
        data.SessionToken = r.SessionToken;
        data.CandidateName = r.Candidate.Name;
        if (data.FinalStatus != null && !r.State.IsFinal)
        {
            data.FinalStatus = null; // invigilator re-opened the attempt
            data.SubmitRequested = false;
        }
        var book = new AnswerBook(_cache, data);
        book.Save();
        if (warning != null) book.AddViolation("cache_tampered", warning);
        foreach (var v in _machine.State.PendingViolations) book.AddViolation(v.Type, v.Detail);
        _machine.Update(s =>
        {
            s.PendingViolations.Clear();
            s.LastExamId = r.ExamId;
            s.LastRollNumber = r.Candidate.RollNumber;
        });

        var session = new ExamSession(api, book, new ServerClock(), r.State,
            TimeSpan.FromSeconds(Math.Max(1, _cfg.AutosaveSeconds)), TimeSpan.FromMilliseconds(Math.Max(100, _cfg.DebounceMilliseconds)));
        session.Changed += () => Dispatcher.BeginInvoke(RefreshStatus);
        session.PaperLoaded += () => Dispatcher.BeginInvoke(BuildPaper);
        session.SessionExpired += () => Dispatcher.BeginInvoke(OnSessionExpired);
        _session = session;
        _flat.Clear();
        _current = -1;
        ExamTitleText.Text = r.State.Title ?? "Exam";
        var seat = r.Candidate.SeatNumber is { } n ? $"  ·  Seat {n}" : "";
        CandidateText.Text = $"{r.Candidate.Name}  ·  {r.Candidate.RollNumber}{seat}";
        ShowView(ExamView);
        Log($"login {r.Candidate.RollNumber} exam={r.ExamId} remaining={r.State.RemainingSeconds}s cachedAnswers={data.Answers.Count}");
        session.Start();
        _uiTimer.Start();
        RefreshStatus();
    }

    private void BuildPaper()
    {
        var s = _session;
        if (s?.Paper == null || _flat.Count > 0) return;
        ExamTitleText.Text = s.Paper.Exam.Title.Length > 0 ? s.Paper.Exam.Title : ExamTitleText.Text;
        SectionBar.Children.Clear();
        PalettePanel.Children.Clear();
        _palette.Clear();
        _sectionButtons.Clear();
        var no = 0;
        foreach (var sec in s.Paper.Sections)
        {
            var first = _flat.Count;
            var sb = new Button { Content = sec.Name, Style = (Style)FindResource("Secondary"), Margin = new Thickness(0, 0, 8, 6), Padding = new Thickness(14, 6, 14, 6) };
            sb.Click += (_, _) => Go(first);
            SectionBar.Children.Add(sb);
            _sectionButtons.Add((sb, first));
            PalettePanel.Children.Add(new TextBlock { Text = sec.Name, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 8, 0, 6), FontSize = 13 });
            var wrap = new WrapPanel();
            foreach (var q in sec.Questions)
            {
                var idx = _flat.Count;
                _flat.Add((sec, q, ++no));
                var b = new Button { Content = no.ToString(), Width = 44, Height = 38, Padding = new Thickness(0), Margin = new Thickness(0, 0, 6, 6), FontSize = 14 };
                b.Click += (_, _) => Go(idx);
                wrap.Children.Add(b);
                _palette.Add(b);
            }
            PalettePanel.Children.Add(wrap);
        }
        var resume = _flat.FindIndex(f => f.Q.Id == s.Book.Data.CurrentQuestionId);
        Go(resume >= 0 ? resume : 0);
    }

    private void Go(int i)
    {
        var s = _session;
        if (s == null || i < 0 || i >= _flat.Count) return;
        AccountTime();
        _current = i;
        var q = _flat[i].Q;
        s.Book.MarkVisited(q.Id);
        s.Book.Update(d => d.CurrentQuestionId = q.Id);
        _onQuestion.Restart();
        RenderQuestion();
        RefreshStatus();
    }

    private void AccountTime()
    {
        if (_session == null || _current < 0 || !_onQuestion.IsRunning) return;
        var secs = (int)_onQuestion.Elapsed.TotalSeconds;
        if (secs > 0) _session.Book.AddTime(_flat[_current].Q.Id, secs);
        _onQuestion.Restart();
    }

    private void RenderQuestion()
    {
        var s = _session!;
        var (sec, q, no) = _flat[_current];
        _rendering = true;
        QNumText.Text = $"Question {no} of {_flat.Count}";
        var neg = q.NegativeMarks > 0 ? q.NegativeMarks : sec.NegativeMarks;
        var marks = q.Marks > 0 ? q.Marks : sec.MarksPerQuestion;
        MarksText.Text = $"{sec.Name}   ·   +{marks:0.##}" + (neg > 0 ? $"  /  −{neg:0.##}" : "");
        QuestionText.Text = q.Text;
        HintText.Text = q.IsMultiple ? "Select all correct options." : "Select one option.";
        var chosen = Selected(s.Book.Get(q.Id)?.AnswerJson);
        OptionsPanel.Children.Clear();
        foreach (var o in q.Options)
        {
            var label = new TextBlock { Text = o.Text, TextWrapping = TextWrapping.Wrap, FontSize = 17 };
            ToggleButton c = q.IsMultiple ? new CheckBox() : new RadioButton { GroupName = "opt" };
            c.Content = label;
            c.Tag = o.Id;
            c.IsChecked = chosen.Contains(o.Id);
            c.Margin = new Thickness(0, 8, 0, 8);
            c.Padding = new Thickness(10, 0, 0, 0);
            c.VerticalContentAlignment = VerticalAlignment.Center;
            c.Checked += OnOptionChanged;
            c.Unchecked += OnOptionChanged;
            OptionsPanel.Children.Add(c);
        }
        FlagButton.Content = s.Book.Get(q.Id)?.Flagged == true ? "Remove flag" : "Flag for review";
        PrevButton.IsEnabled = _current > 0;
        NextButton.Content = _current < _flat.Count - 1 ? "Save & Next  ▶" : "Save";
        _rendering = false;
    }

    private static HashSet<int> Selected(string? json)
    {
        var set = new HashSet<int>();
        if (json == null) return set;
        var n = JsonNode.Parse(json);
        if (n is JsonArray a) foreach (var x in a) { if (x != null) set.Add(x.GetValue<int>()); }
        else if (n is JsonValue v && v.TryGetValue<int>(out var i)) set.Add(i);
        return set;
    }

    private void OnOptionChanged(object sender, RoutedEventArgs e)
    {
        var s = _session;
        if (_rendering || s == null || _current < 0 || !s.CanAnswer) return;
        var q = _flat[_current].Q;
        var ids = OptionsPanel.Children.OfType<ToggleButton>().Where(c => c.IsChecked == true).Select(c => (int)c.Tag).OrderBy(x => x).ToList();
        JsonNode? answer = q.IsMultiple
            ? (ids.Count == 0 ? null : new JsonArray(ids.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()))
            : (ids.Count == 0 ? null : JsonValue.Create(ids[0]));
        s.Book.SetAnswer(q.Id, answer);
        s.AnswerChanged();
    }

    private void Prev_Click(object sender, RoutedEventArgs e) => Go(_current - 1);
    private void Next_Click(object sender, RoutedEventArgs e) => Go(Math.Min(_current + 1, _flat.Count - 1));

    private void Clear_Click(object sender, RoutedEventArgs e)
    {
        if (_session is not { CanAnswer: true } s || _current < 0) return;
        s.Book.SetAnswer(_flat[_current].Q.Id, null);
        s.AnswerChanged();
        RenderQuestion();
    }

    private void Flag_Click(object sender, RoutedEventArgs e)
    {
        if (_session is not { CanAnswer: true } s || _current < 0) return;
        var id = _flat[_current].Q.Id;
        s.Book.SetFlag(id, s.Book.Get(id)?.Flagged != true);
        s.AnswerChanged();
        RenderQuestion();
    }
}
