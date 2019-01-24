module Main where

import Toppokki as T
import Prelude
import Effect.Aff (launchAff_)
import Effect (Effect)
import QuickServe (JSON(..), POST, RequestBody(..), quickServe)
import Data.Maybe (Maybe (..))
import Foreign.Class (class Decode, class Encode)
import Foreign.Generic (defaultOptions, genericDecode, genericEncode)
import Foreign.Generic.Types (Options)
import Data.Generic.Rep (class Generic)
import Data.Map (Map)

browserStuff :: Effect Unit
browserStuff = launchAff_ do
  browser <- T.launch {}
  page <- T.newPage browser
  T.goto (T.URL "https://example.com") page
  content <- T.content page
  _ <- T.screenshot {path: "./test/test.png"} page
  _ <- T.pdf {path: "./test/test.pdf"} page
  T.close browser

jsonOpts :: Options
jsonOpts = defaultOptions { unwrapSingleConstructors = true }

newtype ChaseRequest = ChaseRequest { webhookURL :: String, creds :: ChaseCreds }
newtype ChaseCreds = ChaseCreds { username :: String, password :: String }
newtype BofaRequest = BofaRequest { webhookURL :: String, creds :: BofaCreds }
newtype BofaCreds = BofaCreds { username :: String, password :: String, secretQuestionAnswers :: Map String String }

derive instance genericChaseRequest :: Generic ChaseRequest _
derive instance genericChaseCreds :: Generic ChaseCreds _
derive instance genericBofaCreds :: Generic BofaCreds _
derive instance genericBofaRequest :: Generic BofaRequest _
instance decodeChaseRequest :: Decode ChaseRequest where
  decode = genericDecode jsonOpts
instance encodeChaseRequest :: Encode ChaseRequest where
  encode = genericEncode jsonOpts
instance decodeChaseCreds :: Decode ChaseCreds where
  decode = genericDecode jsonOpts
instance encodeChaseCreds :: Encode ChaseCreds where
  encode = genericEncode jsonOpts
instance decodeBofaRequest :: Decode BofaRequest where
  decode = genericDecode jsonOpts
instance encodeBofaRequest :: Encode BofaRequest where
  encode = genericEncode jsonOpts
instance decodeBofaCreds :: Decode BofaCreds where
  decode = genericDecode jsonOpts
instance encodeBofaCreds :: Encode BofaCreds where
  encode = genericEncode jsonOpts

chase :: RequestBody (JSON ChaseRequest) -> POST String
chase (RequestBody (JSON (ChaseRequest { webhookURL, creds }))) = pure ""

bofa :: RequestBody (JSON BofaRequest) -> POST String
bofa (RequestBody (JSON (BofaRequest { webhookURL, creds }))) = pure ""

main :: Effect Unit
main =
  let opts = { hostname: "localhost", port: 3200, backlog: Nothing }
  in quickServe opts { chase, bofa }
