module Main where

import Prelude

import Data.Maybe (Maybe (..))
import Effect (Effect)
import Effect.Aff (runAff)
import Effect.Console (log)
import Effect.Class (liftEffect)
import QuickServe (JSON(..), POST, RequestBody(..), quickServe)

import Scrapers.Chase as Chase
import Data.Foldable (intercalate)
import Data.Argonaut (stringify)
import Types (BofaRequest(..), ChaseRequest(..), ScrapeResult(..))

-- FIXME post results to webhookurl
chase :: RequestBody (JSON ChaseRequest) -> POST (JSON Unit)
chase (RequestBody (JSON (ChaseRequest { webhookURL, creds }))) = do
  _ <- liftEffect $ runAff (\eRes -> log $ show $ 
         map (\res -> case res of
                 Success s -> intercalate "\n" $ map stringify s
                 Failure -> "scrape failed") eRes) $ Chase.scrape creds
  pure $ JSON unit

bofa :: RequestBody (JSON BofaRequest) -> POST (JSON Unit)
bofa (RequestBody (JSON (BofaRequest { webhookURL, creds }))) = pure $ JSON unit

main :: Effect Unit
main =
  let opts = { hostname: "localhost", port: 3200, backlog: Nothing }
  in quickServe opts { chase, bofa }
