import SwiftUI

@main
struct DJSyncMenuApp: App {
  @State private var model = MenuModel()

  var body: some Scene {
    MenuBarExtra {
      MenuView(model: model)
    } label: {
      Image(systemName: model.menuBarSymbol)
    }
    .menuBarExtraStyle(.window)
  }
}
