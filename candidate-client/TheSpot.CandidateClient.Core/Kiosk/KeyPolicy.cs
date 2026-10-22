namespace TheSpot.CandidateClient.Core.Kiosk;

public enum KeyDecision { Allow, Block, InvigilatorExit }

/// <summary>Which keystrokes the kiosk's low-level keyboard hook swallows. Pure logic so it can be unit tested.</summary>
public static class KeyPolicy
{
    public const int VK_TAB = 0x09, VK_ESCAPE = 0x1B, VK_SPACE = 0x20, VK_SNAPSHOT = 0x2C, VK_INSERT = 0x2D, VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_APPS = 0x5D;
    public const int VK_F4 = 0x73, VK_F12 = 0x7B, VK_C = 0x43, VK_V = 0x56, VK_X = 0x58;

    /// <summary>Hidden invigilator combo: Ctrl+Alt+Shift+F12.</summary>
    public static KeyDecision Evaluate(int vk, bool alt, bool ctrl, bool shift, out string? violation)
    {
        violation = null;
        if (vk == VK_F12 && ctrl && alt && shift) return KeyDecision.InvigilatorExit;
        violation = vk switch
        {
            VK_LWIN or VK_RWIN => "win_key",
            VK_TAB when alt => "alt_tab",
            VK_ESCAPE when alt => "alt_esc",
            VK_ESCAPE when ctrl && shift => "ctrl_shift_esc",
            VK_ESCAPE when ctrl => "ctrl_esc",
            VK_F4 when alt => "alt_f4",
            VK_SPACE when alt => "alt_space",
            VK_SNAPSHOT => "print_screen",
            VK_APPS => "context_menu_key",
            VK_C when ctrl => "copy",
            VK_X when ctrl => "cut",
            VK_V when ctrl => "paste",
            VK_INSERT when ctrl || shift => ctrl ? "copy" : "paste",
            _ => null,
        };
        return violation == null ? KeyDecision.Allow : KeyDecision.Block;
    }

    /// <summary>Readable key name for violation details, e.g. "Alt+Tab".</summary>
    public static string Describe(int vk, bool alt, bool ctrl, bool shift)
    {
        var key = vk switch
        {
            VK_TAB => "Tab",
            VK_ESCAPE => "Esc",
            VK_SPACE => "Space",
            VK_SNAPSHOT => "PrintScreen",
            VK_INSERT => "Insert",
            VK_LWIN => "LWin",
            VK_RWIN => "RWin",
            VK_APPS => "Apps",
            VK_F4 => "F4",
            VK_F12 => "F12",
            >= 0x41 and <= 0x5A => ((char)vk).ToString(),
            _ => "0x" + vk.ToString("X2"),
        };
        return (ctrl ? "Ctrl+" : "") + (alt ? "Alt+" : "") + (shift ? "Shift+" : "") + key;
    }
}
