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
                    HarmonyInstance.Patch(refresh, postfix: new HarmonyMethod(typeof(HelperMod), nameof(RefreshPostfix))
                    {
                        priority = HarmonyLib.Priority.First,  // before other mods' patches, which may crash
                    });
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

        object LoadManager() => menuLoadManager ?? GetStaticInstance(loadManagerType) ?? FindStaticOfType(loadManagerType);

        void TryStartLoad(float now)
        {
            var lm = LoadManager();
            var save = FindSave(lm, out var why);
            if (now >= nextReport)
            {
                nextReport = now + 10f;
                if (!dumped)
                {
                    dumped = true;
                    LoggerInstance.Msg("LoadManager members: " + DescribeMembers(loadManagerType));
                }
                if (save == null)
                    LoggerInstance.Msg($"Waiting at the menu: LoadManager {(lm == null ? "not found" : "found")}, {why}.");
            }
            if (save == null)
                return;
            var startProbe = FindStartGame(save);
            if (startProbe != null && !startProbe.IsStatic && lm == null)
                return;  // StartGame needs the LoadManager itself; wait for it
            if (savesSeenAt < 0)
            {
                savesSeenAt = now;  // let the main menu finish appearing first
                return;
            }
            if (now - savesSeenAt < MenuSettleSeconds)
                return;

            var start = FindStartGame(save);
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

        MethodInfo FindStartGame(object save) =>
            loadManagerType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
                .Where(m => m.Name == "StartGame")
                .Where(m => m.GetParameters().Length > 0 && m.GetParameters()[0].ParameterType.IsInstanceOfType(save))
                .OrderBy(m => m.GetParameters().Length)
                .FirstOrDefault();

        void CheckLoaded(float now)
        {
            var lm = LoadManager();
            bool? loading = ReadBool(lm, loadManagerType, "IsLoading");
            bool? loaded = ReadBool(lm, loadManagerType, "IsGameLoaded");
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

        object FindSave(object lm, out string why)
        {
            // SaveGames may belong to the LoadManager or to the class as a whole (static).
            var saves = ReadMember(lm, loadManagerType, "SaveGames") as IEnumerable;
            if (saves == null)
            {
                why = "its SaveGames list isn't there yet";
                return null;
            }
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
                    {
                        why = "";
                        return s;
                    }
                }
            }
            why = $"save '{wanted}' isn't among the game's {count} saves (yet)";
            if (count > 0 && savesSeenAt < 0 && !loggedSaves)
            {
                loggedSaves = true;
                LoggerInstance.Warning(why);
            }
            return null;
        }
        bool loggedSaves;
        bool dumped;
        float nextReport;

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

        // A property or field of the object, or a static one of its class (or the class's bases).
        static object ReadMember(object o, Type type, string name)
        {
            const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                                     | BindingFlags.Static | BindingFlags.FlattenHierarchy;
            for (var t = o?.GetType() ?? type; t != null; t = t.BaseType)
            {
                try
                {
                    var p = t.GetProperty(name, any | BindingFlags.DeclaredOnly);
                    if (p != null && p.GetIndexParameters().Length == 0)
                    {
                        var isStatic = p.GetMethod?.IsStatic == true;
                        if (isStatic || o != null)
                            return p.GetValue(isStatic ? null : o);
                    }
                    var f = t.GetField(name, any | BindingFlags.DeclaredOnly);
                    if (f != null && (f.IsStatic || o != null))
                        return f.GetValue(f.IsStatic ? null : o);
                }
                catch { return null; }
            }
            return null;
        }

        static bool? ReadBool(object o, Type type, string name) => ReadMember(o, type, name) is bool b ? b : (bool?)null;

        // Any static property/field (on the class or its bases) that holds a LoadManager.
        static object FindStaticOfType(Type type)
        {
            const BindingFlags st = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly;
            for (var t = type; t != null; t = t.BaseType)
            {
                foreach (var p in t.GetProperties(st))
                {
                    if (!type.IsAssignableFrom(p.PropertyType) || p.GetIndexParameters().Length > 0)
                        continue;
                    try { var v = p.GetValue(null); if (v != null) return v; } catch { }
                }
                foreach (var f in t.GetFields(st))
                {
                    if (!type.IsAssignableFrom(f.FieldType))
                        continue;
                    try { var v = f.GetValue(null); if (v != null) return v; } catch { }
                }
            }
            return null;
        }

        static string DescribeMembers(Type type)
        {
            const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
            var props = type.GetProperties(any).Where(p => p.Name.Contains("Save") || p.Name.Contains("Load") || p.Name == "Instance")
                .Select(p => $"{(p.GetMethod?.IsStatic == true ? "static " : "")}{p.PropertyType.Name} {p.Name}");
            var methods = type.GetMethods(any).Where(m => m.Name.Contains("StartGame") || m.Name.Contains("LoadGame"))
                .Select(Describe);
            return string.Join("; ", props.Concat(methods).Distinct());
        }

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
