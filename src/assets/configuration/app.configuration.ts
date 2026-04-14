import DfdValidator from "./DfdValidator/DfdValidator";
import DfdPublisher from "./DfdPublisher/DfdPublisher";
import DfdFilePreprocessor from "./DfdFilePreprocessor/DfdFilePreprocessor";
import DfdCommandProcessor from "./DfdCommandProcessor/DfdCommandProcessor";
import { DarkTheme } from "./DfdThemes/DarkTheme";
import { LightTheme } from "./DfdThemes/LightTheme";
import { DfdCanvas, DfdObjects, BaseTemplates } from "./DfdTemplates";
import type { AppConfiguration } from "../scripts/Application";

const configuration: AppConfiguration = {

    /**
     * The application's name.
     */
    application_name: "DFD Editor",

    /**
     * The application's icon.
     */
    application_icon: "/favicon.png",

    /**
     * The application file type's name.
     */
    file_type_name: "Data Flow Diagram",

    /**
     * The application file type's extension.
     */
    file_type_extension: "dfd",

    /**
     * The application's splash screen configuration.
     */
    splash: {
        organization: "",
        new_file: {
            title: "New Diagram",
            description: "Create a blank data flow diagram."
        },
        open_file: {
            title: "Open Diagram",
            description: "Open an existing diagram."
        },
        import_stix: {
            title: "",
            description: ""
        },
        help_links: [
            {
                title: "Getting Started",
                description: "Read the DFD Editor getting-started guide.",
                url: "docs/getting-started.md"
            }
        ]
    },

    /**
     * The application's schema.
     */
    schema: {
        id: "dfd_v1",
        canvas: DfdCanvas,
        templates: [
            ...BaseTemplates,
            ...DfdObjects
        ]
    },

    /**
     * The application's themes.
     */
    themes: [
        LightTheme,
        DarkTheme
    ],

    /**
     * The application's menus.
     */
    menus: {
        help_menu: {
            help_links: [
                {
                    text: "DFD Editor on GitHub",
                    url: "https://github.com/center-for-threat-informed-defense/attack-flow"
                }
            ]
        }
    },

    validator: {
        create: () => new DfdValidator()
    },

    publisher: {
        create: () => new DfdPublisher(),
        menuText: "Export DFD as JSON"
    },

    filePreprocessor: {
        create: () => new DfdFilePreprocessor()
    },

    cmdProcessor: {
        create: () => new DfdCommandProcessor()
    }

};

export default configuration;
