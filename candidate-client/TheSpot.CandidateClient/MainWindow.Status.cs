using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using TheSpot.CandidateClient.Core.Sync;

namespace TheSpot.CandidateClient;

public partial class MainWindow
{
    private static readonly Brush OnlineBg = new SolidColorBrush(Color.FromRgb(0x1E, 0x7A, 0x46));
    private static readonly Brush OfflineBg = new SolidColorBrush(Color.FromRgb(0xC6, 0x28, 0x28));
    private static readonly Brush OnlineDot = new SolidColorBrush(Color.FromRgb(0x7C, 0xF0, 0xA8));
    private static readonly Brush OfflineDot = new SolidColorBrush(Color.FromRgb(0xFF, 0xD5, 0xD5));
    private static readonly Brush LowTime = new SolidColorBrush(Color.FromRgb(0xFF, 0xB0, 0x4D));

    private void RefreshStatus()
    {
        var s = _session;
        if (s == null) return;
        if (s.Phase == SessionPhase.Finished)
        {
            ShowFinished(s);
            return;
        }
        if (_flat.Count == 0 && s.Paper != null) BuildPaper();

        var rem = s.Clock.RemainingSeconds;
        TimerText.Text = ServerClock.Format(rem);
        TimerText.Foreground = rem <= 300 && s.State.HasStarted ? LowTime : Brushes.White;

        var pending = s.Book.PendingCount + s.Book.PendingViolationCount;
        var online = s.Online && !s.PinMismatch;
        ConnBorder.Background = online ? OnlineBg : OfflineBg;
        ConnDot.Fill = online ? OnlineDot : OfflineDot;
        ConnText.Text = s.PinMismatch ? "SERVER CERTIFICATE MISMATCH — not sending"
            : !s.Online ? $"OFFLINE — answers kept safely on this PC ({pending} pending)"
            : pending > 0 ? "Online · saving…"
            : "Online · all answers saved";

        string? title = null, detail = null;
        if (s.Phase == SessionPhase.Waiting)
            (title, detail) = ("Waiting for the exam to start", "The invigilator starts the exam from the Center Server. Your timer starts at that moment.");
        else if (s.Phase == SessionPhase.Paused)
            (title, detail) = ("Exam paused", "The invigilator has paused the exam. Your time is not running.");
        else if (s.Phase == SessionPhase.TimeUp || s.Book.Data.SubmitRequested)
            (title, detail) = (s.Phase == SessionPhase.TimeUp ? "Time is up" : "Submitting your exam…",
                online ? "Sending your answers to the Center Server…" : "Waiting for the Center Server. Your answers are safe on this PC — do not switch it off.");
        else if (s.Paper == null)
            (title, detail) = ("Loading questions…", online ? "" : "Waiting for the Center Server…");
        PhaseOverlay.Visibility = title != null ? Visibility.Visible : Visibility.Collapsed;
        PhaseTitle.Text = title ?? "";
        PhaseDetail.Text = detail ?? "";

        var can = s.CanAnswer;
        OptionsPanel.IsEnabled = can;
        ClearButton.IsEnabled = can;
        FlagButton.IsEnabled = can;
        SubmitButton.IsEnabled = can;
        RefreshPalette();
    }

    private void RefreshPalette()
    {
        var s = _session;
        if (s == null) return;
        int answered = 0, flagged = 0;
        for (var i = 0; i < _palette.Count; i++)
        {
            var a = s.Book.Get(_flat[i].Q.Id);
            var isAnswered = a?.AnswerJson != null;
            if (isAnswered) answered++;
            if (a?.Flagged == true) flagged++;
            var key = a?.Flagged == true ? "Flagged" : isAnswered ? "Answered" : a?.Visited == true ? "NotAnswered" : "NotVisited";
            var b = _palette[i];
            b.Background = (Brush)FindResource(key);
            b.Foreground = key == "NotVisited" ? (Brush)FindResource("Ink") : Brushes.White;
            b.BorderBrush = i == _current ? (Brush)FindResource("Ink") : Brushes.Transparent;
            b.BorderThickness = new Thickness(i == _current ? 3 : 0);
        }
        foreach (var (btn, first) in _sectionButtons)
        {
            var active = _current >= 0 && _flat[_current].Section == _flat[first].Section;
            btn.Background = active ? (Brush)FindResource("Primary") : Brushes.White;
            btn.Foreground = active ? Brushes.White : (Brush)FindResource("Ink");
        }
        SummaryText.Text = $"Answered {answered} of {_flat.Count}  ·  Flagged {flagged}  ·  Not answered {_flat.Count - answered}";
    }

    private void ShowFinished(ExamSession s)
    {
        if (FinishedView.Visibility != Visibility.Visible)
        {
            AccountTime();
            ShowView(FinishedView);
            SubmitOverlay.Visibility = Visibility.Collapsed;
            Log($"finished {s.Book.Data.FinalStatus} auto={s.AutoSubmitted}");
        }
        var status = s.Book.Data.FinalStatus;
        (FinishedTitle.Text, FinishedDetail.Text) = status switch
        {
            "submitted" when s.AutoSubmitted => ("Time is up", "The exam time is over. Your answers were submitted automatically."),
            "submitted" => ("Exam submitted", "Your answers have been submitted."),
            "auto_submitted" => ("Time is up", "The exam time is over. Your answers were submitted automatically."),
            "force_submitted" => ("Exam ended", "The invigilator ended the exam. Your answers were submitted."),
            "disqualified" => ("Exam closed", "Your attempt was closed by the invigilator."),
            _ => ("Exam closed", $"Your attempt is {status}."),
        };
        var total = _flat.Count > 0 ? _flat.Count : s.Paper?.Sections.Sum(x => x.Questions.Count) ?? 0;
        var answered = s.Book.AnsweredCount;
        var pending = s.Book.PendingCount;
        FinishedSync.Text = $"Answered {answered} of {total} questions.  " + (pending == 0
            ? "All answers are saved on the Center Server."
            : s.UploadsClosed ? $"{pending} answer(s) reached the server too late and were not accepted. They are kept encrypted on this PC; please tell the invigilator."
            : s.Online ? $"Sending {pending} remaining answer(s)…"
            : $"Offline: {pending} answer(s) will be sent when the LAN is back. Do not switch off this PC.");
    }

    private void Submit_Click(object sender, RoutedEventArgs e)
    {
        if (_session is not { CanAnswer: true } s) return;
        var answered = s.Book.AnsweredCount;
        var flagged = _flat.Count(f => s.Book.Get(f.Q.Id)?.Flagged == true);
        SubmitSummaryText.Text = $"Answered: {answered} of {_flat.Count}\nNot answered: {_flat.Count - answered}\nFlagged for review: {flagged}";
        SubmitOverlay.Visibility = Visibility.Visible;
    }

    private void CancelSubmit_Click(object sender, RoutedEventArgs e) => SubmitOverlay.Visibility = Visibility.Collapsed;

    private void ConfirmSubmit_Click(object sender, RoutedEventArgs e)
    {
        SubmitOverlay.Visibility = Visibility.Collapsed;
        if (_session == null) return;
        AccountTime();
        _session.RequestSubmit();
        RefreshStatus();
    }
}
