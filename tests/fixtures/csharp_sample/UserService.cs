using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace MyApp.Services {
    public interface IUserService {
        Task<string> GetUser(int id);
        void DeleteUser(int id);
    }

    public delegate void UserChangedHandler(object sender, EventArgs e);

    public class UserService : IUserService {
        private readonly List<string> _users;

        public string ServiceName { get; set; }
        public int Count { get; private set; }

        public UserService(List<string> users) {
            _users = users;
        }

        public async Task<string> GetUser(int id) {
            return _users[id];
        }

        public void DeleteUser(int id) {
            _users.RemoveAt(id);
        }

        public static int GetVersion() {
            return 1;
        }

        public const string VERSION = "1.0";

        public enum Status {
            Active,
            Inactive,
            Banned
        }
    }

    public struct Point {
        public int X;
        public int Y;
    }

    public abstract class AbstractBase {
        public abstract void Process();
    }
}
