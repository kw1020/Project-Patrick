// GameSwap's helper mod for Schedule I (MelonLoader).
//
// Schedule I always opens on its main menu, and its menu can't be clicked
// safely from outside the game. This mod does two things, and only when
// GameSwap asks:
//
// 1. Load your save. Before launching Schedule I, GameSwap writes the save
//    slot's folder name (e.g. "SaveGame_1") to UserData/GameSwap/load-request.txt.
//    Once the main menu has listed your saves, the mod loads that save and
//    deletes the request. Starting the game yourself (no request) leaves the
//    menu alone.
// 2. Say when you're in. When the save has finished loading, the mod writes
//    UserData/GameSwap/status.txt ("in-game SaveGame_1 ..."), and GameSwap
//    starts the timer.
//
// It finds the game's own classes by name at run time, instead of being
// compiled against one game version, and logs what it finds, so a game
// update shows up clearly in MelonLoader's Latest.log.

using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using MelonLoader;
using MelonLoader.Utils;

[assembly: MelonInfo(typeof(GameSwapHelper.HelperMod), "GameSwapHelper", "1.0.0", "GameSwap")]
[assembly: MelonGame("TVGS", "Schedule I")]

namespace GameSwapHelper
{
    public class HelperMod : MelonMod
    {
        const string LoadManagerName = "Il2CppScheduleOne.Persistence.LoadManager";
        const double RequestMaxAgeMinutes = 15;
        const float MenuSettleSeconds = 2f;
        const float FallbackReadySeconds = 12f;

        static object menuLoadManager;  // from the RefreshSaveInfo patch

        string wanted;            // save slot folder GameSwap asked for, or null
        Type loadManagerType;
        float nextPoll;
        float savesSeenAt = -1f;
        bool loadStarted;
        bool reported;
        string menuScene;
        string sceneAfterLoad;
        float sceneAfterLoadAt;
        bool sawLoading;

        static string Folder => Path.Combine(MelonEnvironment.UserDataDirectory, "GameSwap");
        static string RequestFile => Path.Combine(Folder, "load-request.txt");
        static string StatusFile => Path.Combine(Folder, "status.txt");

        public override void OnInitializeMelon()
        {
            try
            {
                Directory.CreateDirectory(Folder);
                if (!File.Exists(RequestFile))
                {
                    LoggerInstance.Msg("No load request from GameSwap: staying on the main menu.");
                    return;
                }
                var age = DateTime.UtcNow - File.GetLastWriteTimeUtc(RequestFile);
                var text = File.ReadAllText(RequestFile).Trim();
                if (age.TotalMinutes > RequestMaxAgeMinutes || text.Length == 0)
                {
                    LoggerInstance.Msg($"Ignoring an old load request ('{text}', {age.TotalMinutes:0} min old).");
                    File.Delete(RequestFile);
                    return;
                }
                wanted = text;
                WriteStatus($"loading {wanted}");
                LoggerInstance.Msg($"GameSwap asked to load save '{wanted}'.");
            }
            catch (Exception e)
            {
                LoggerInstance.Error($"Couldn't read GameSwap's request: {e}");
                return;
            }

            loadManagerType = FindType(LoadManagerName);
            if (loadManagerType == null)
            {
                Fail($"the game's {LoadManagerName} class wasn't found");
                return;
            }
            var refresh = AccessTools.Method(loadManagerType, "RefreshSaveInfo");
            if (refresh != null)
            {
                try
                {
                    HarmonyInstance.Patch(refresh, postfix: new HarmonyMethod(typeof(HelperMod), nameof(RefreshPostfix)));
                }
                catch (Exception e)
                {
                    LoggerInstance.Warning($"Couldn't watch RefreshSaveInfo ({e.Message}); polling instead.");
                }
            }
        }

        static void RefreshPostfix(object __instance)
        {
            menuLoadManager = __instance;
        }

        public override void OnSceneWasInitialized(int buildIndex, string sceneName)
        {
            if (wanted == null)
                return;
            LoggerInstance.Msg($"Scene '{sceneName}' ({buildIndex}) loaded.");
            if (!loadStarted)
                menuScene = sceneName;
            else if (sceneName != menuScene && sceneAfterLoad == null)
            {
                sceneAfterLoad = sceneName;
                sceneAfterLoadAt = UnityTime();
            }
        }

        public override void OnUpdate()
        {
            if (wanted == null || reported)
                return;
            float now = UnityTime();
            if (now < nextPoll)
                return;
            nextPoll = now + 0.5f;
            try
            {
                if (!loadStarted)
                    TryStartLoad(now);
                else
                    CheckLoaded(now);
            }
            catch (Exception e)
            {
                Fail($"unexpected error: {e}");
            }
        }

        void TryStartLoad(float now)
        {
            var lm = menuLoadManager ?? GetStaticInstance(loadManagerType);
            if (lm == null)
                return;
            var save = FindSave(lm);
            if (save == null)
                return;
            if (savesSeenAt < 0)
            {
                savesSeenAt = now;  // let the main menu finish appearing first
                return;
            }
            if (now - savesSeenAt < MenuSettleSeconds)
                return;

            var start = loadManagerType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
                .Where(m => m.Name == "StartGame")
                .Where(m => m.GetParameters().Length > 0 && m.GetParameters()[0].ParameterType.IsInstanceOfType(save))
                .OrderBy(m => m.GetParameters().Length)
                .FirstOrDefault();
            if (start == null)
            {
                var all = string.Join("; ", loadManagerType.GetMethods().Where(m => m.Name.Contains("Start") || m.Name.Contains("Load")).Select(Describe));
                Fail($"no StartGame(SaveInfo, ...) method found. Candidates: {all}");
                return;
            }
            var args = start.GetParameters().Select((p, i) => i == 0 ? save : DefaultFor(p)).ToArray();
            LoggerInstance.Msg($"Loading save '{wanted}' with {Describe(start)}.");
            loadStarted = true;
            start.Invoke(start.IsStatic ? null : lm, args);
            try { File.Delete(RequestFile); } catch { }
        }

        void CheckLoaded(float now)
        {
            var lm = menuLoadManager ?? GetStaticInstance(loadManagerType);
            bool? loading = lm == null ? null : ReadBool(lm, "IsLoading");
            bool? loaded = lm == null ? null : ReadBool(lm, "IsGameLoaded");
            if (loading == true)
                sawLoading = true;
            bool ready;
            string how;
            if (loaded.HasValue)
            {
                ready = loaded.Value && loading != true;
                how = "IsGameLoaded";
            }
            else if (loading.HasValue && sawLoading)
            {
                ready = !loading.Value && sceneAfterLoad != null;
                how = "IsLoading finished";
            }
            else
            {
                ready = sceneAfterLoad != null && now - sceneAfterLoadAt >= FallbackReadySeconds;
                how = $"scene '{sceneAfterLoad}' + {FallbackReadySeconds:0} s";
            }
            if (!ready)
                return;
            reported = true;
            WriteStatus($"in-game {wanted}");
            LoggerInstance.Msg($"In game: save '{wanted}' has loaded ({how}).");
        }

        // ---- helpers ----------------------------------------------------------------

        object FindSave(object lm)
        {
            var saves = ReadMember(lm, "SaveGames") as IEnumerable;
            if (saves == null)
                return null;
            int count = 0;
            foreach (var s in saves)
            {
                if (s == null)
                    continue;
                count++;
                foreach (var p in s.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (p.PropertyType != typeof(string) || p.GetIndexParameters().Length > 0)
                        continue;
                    string v;
                    try { v = p.GetValue(s) as string; } catch { continue; }
                    if (v == null)
                        continue;
                    var t = v.TrimEnd('/', '\\');
                    if (string.Equals(t, wanted, StringComparison.OrdinalIgnoreCase)
                        || t.EndsWith("/" + wanted, StringComparison.OrdinalIgnoreCase)
                        || t.EndsWith("\\" + wanted, StringComparison.OrdinalIgnoreCase))
                        return s;
                }
            }
            if (count > 0 && savesSeenAt < 0 && !loggedSaves)
            {
                loggedSaves = true;
                LoggerInstance.Warning($"Save '{wanted}' isn't among the game's {count} saves yet.");
            }
            return null;
        }
        bool loggedSaves;

        void Fail(string why)
        {
            reported = true;
            LoggerInstance.Error($"Couldn't load the save by itself: {why}. Load it yourself and press GameSwap's Start timer now.");
            WriteStatus($"failed {why}");
        }

        void WriteStatus(string text)
        {
            try { File.WriteAllText(StatusFile, $"{text}\n{DateTime.UtcNow:o}\n"); }
            catch (Exception e) { LoggerInstance.Warning($"Couldn't write {StatusFile}: {e.Message}"); }
        }

        static Type FindType(string name)
        {
            var t = Type.GetType(name + ", Assembly-CSharp");
            if (t != null)
                return t;
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    t = a.GetType(name);
                    if (t != null)
                        return t;
                }
                catch { }
            }
            return null;
        }

        static object GetStaticInstance(Type type)
        {
            for (var t = type; t != null; t = t.BaseType)
            {
                var p = t.GetProperty("Instance", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly);
                if (p == null)
                    continue;
                try { return p.GetValue(null); } catch { return null; }
            }
            return null;
        }

        static object ReadMember(object o, string name)
        {
            var t = o.GetType();
            try
            {
                var p = t.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (p != null)
                    return p.GetValue(o);
                var f = t.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                return f?.GetValue(o);
            }
            catch { return null; }
        }

        static bool? ReadBool(object o, string name) => ReadMember(o, name) is bool b ? b : (bool?)null;

        static object DefaultFor(ParameterInfo p)
        {
            if (p.HasDefaultValue)
                return p.DefaultValue;
            return p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null;
        }

        static string Describe(MethodInfo m) =>
            $"{m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name + " " + p.Name))})";

        static float UnityTime() => (float)(DateTime.UtcNow - Started).TotalSeconds;
        static readonly DateTime Started = DateTime.UtcNow;
    }
}
