use plur1bus_desktop::controller::autostart::{set_enabled, AppLauncher, LaunchFailure};
use std::cell::{Cell, RefCell};
#[derive(Default)]
struct Launcher {
    enabled: Cell<bool>,
    fail: Cell<bool>,
    calls: RefCell<Vec<&'static str>>,
}
impl AppLauncher for Launcher {
    fn is_enabled(&self) -> Result<bool, LaunchFailure> {
        self.calls.borrow_mut().push("read");
        Ok(self.enabled.get())
    }
    fn enable(&self) -> Result<(), LaunchFailure> {
        self.calls.borrow_mut().push("enable");
        if self.fail.get() {
            return Err(LaunchFailure::Enable);
        }
        self.enabled.set(true);
        Ok(())
    }
    fn disable(&self) -> Result<(), LaunchFailure> {
        self.calls.borrow_mut().push("disable");
        self.enabled.set(false);
        Ok(())
    }
}
#[test]
fn autostart_toggle_calls_the_launcher() {
    let launcher = Launcher::default();
    assert_eq!(set_enabled(&launcher, true), Ok(true));
    assert_eq!(set_enabled(&launcher, false), Ok(false));
    assert_eq!(
        *launcher.calls.borrow(),
        ["enable", "read", "disable", "read"]
    );
}
#[test]
fn failed_autostart_write_does_not_report_enabled() {
    let launcher = Launcher::default();
    launcher.fail.set(true);
    assert_eq!(set_enabled(&launcher, true), Err(LaunchFailure::Enable));
    assert!(!launcher.enabled.get());
    assert_eq!(*launcher.calls.borrow(), ["enable"]);
}

#[test]
fn login_start_keeps_gnome_dash_entry_without_stealing_focus() {
    use plur1bus_desktop::lifecycle::{WindowFailure, WindowHost};
    struct Windows(RefCell<Vec<&'static str>>);
    impl WindowHost for Windows {
        fn exists(&self, _: &str) -> bool {
            true
        }
        fn present(&self, _: &str) -> Result<(), WindowFailure> {
            panic!("login must not steal focus")
        }
        fn show(&self, _: &str) -> Result<(), WindowFailure> {
            self.0.borrow_mut().push("show");
            Ok(())
        }
        fn hide(&self, _: &str) -> Result<(), WindowFailure> {
            self.0.borrow_mut().push("hide");
            Ok(())
        }
        fn minimize(&self, _: &str) -> Result<(), WindowFailure> {
            self.0.borrow_mut().push("minimize");
            Ok(())
        }
    }
    let windows = Windows(RefCell::new(vec![]));
    plur1bus_desktop::controller::autostart::on_login(&windows, true).unwrap();
    assert_eq!(*windows.0.borrow(), ["hide"]);
    windows.0.borrow_mut().clear();
    plur1bus_desktop::controller::autostart::on_login(&windows, false).unwrap();
    assert_eq!(*windows.0.borrow(), ["show", "minimize"]);
}
